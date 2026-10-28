"""Stateless UI adapter. Gate owns authentication, admission and accounting.

No database, background generation queue, result files or upstream NAI secret.
The browser keeps its queue open and saves each final result before continuing.
"""
import asyncio
import base64
import hashlib
import json
import math
import os
import io
import time
from collections import OrderedDict, deque
from pathlib import Path

import httpx
from PIL import Image
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from .adapters import MAX_IMAGE_PIXELS, AdapterError, NaiAdapter, build_request
from .config import Settings
from .inpaint import validate_mask_selection
from .task_validation import validate_task

OPERATIONS = ['generate', 'img2img', 'inpaint', 'encode_vibe', 'upscale', 'augment']
MODELS = [
    dict(id='nai-diffusion-4-5-full', name='NAI Diffusion V4.5 Full', max_characters=6, precise_reference=True, vibe_transfer=True),
    dict(id='nai-diffusion-4-5-curated', name='NAI Diffusion V4.5 Curated', max_characters=6, precise_reference=True, vibe_transfer=True),
    dict(id='nai-diffusion-5-full', name='NAI Diffusion V5 Full', max_characters=32, precise_reference=False, vibe_transfer=False),
    dict(id='nai-diffusion-5-curated', name='NAI Diffusion V5 Curated', max_characters=32, precise_reference=False, vibe_transfer=False),
    dict(id='nai-diffusion-4-full', name='NAI Diffusion V4 Full', max_characters=6, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-4-curated-preview', name='NAI Diffusion V4 Curated', max_characters=6, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-furry-3', name='NAI Diffusion Furry V3', max_characters=0, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-3', name='NAI Diffusion V3', max_characters=0, precise_reference=False, vibe_transfer=True),
]

# Quote requests are informational only. Keep them separate from the image
# execution admission and retry policy below.
QUOTE_MAX_BODY_BYTES = 25 * 1024 * 1024
QUOTE_READ_TIMEOUT_SECONDS = 30
QUOTE_MAX_CONCURRENCY = 2
QUOTE_MAX_PARSE_CONCURRENCY = 1
QUOTE_RATE_WINDOW_SECONDS = 60
QUOTE_GLOBAL_RATE_PER_WINDOW = 600
QUOTE_KEY_RATE_PER_WINDOW = 180
REQUEST_READ_TIMEOUT_SECONDS = 30
EXECUTE_PREP_MAX_CONCURRENCY = 8
TAG_MAX_CONCURRENCY = 8
GATE_IDENTITY_CACHE_TTL_SECONDS = 15
GATE_IDENTITY_FAILURE_CACHE_TTL_SECONDS = 2
GATE_IDENTITY_CACHE_MAX_ENTRIES = 256
GATE_IDENTITY_LOOKUP_MAX_CONCURRENCY = 4
GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW = 240
MASK_PREFLIGHT_CACHE_MAX_ENTRIES = 32
_mask_preflight_cache = OrderedDict()


def _security_now():
    return time.monotonic()


def _prune_window(events, now, window):
    while events and now - events[0] >= window:
        events.popleft()

def _queue_status_now():
    return time.monotonic()


def _queue_status_payload(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('global'), dict):
        raise ValueError('invalid queue snapshot')
    source = raw['global']
    counts = {}
    for name in ('active', 'waiting', 'concurrency'):
        value = source.get(name)
        if type(value) is not int or value < 0:
            raise ValueError('invalid queue count')
        counts[name] = value
    cooldown = raw.get('image_cooldown_remaining')
    if type(cooldown) not in (int, float) or not math.isfinite(cooldown) or cooldown < 0:
        raise ValueError('invalid queue cooldown')
    return {'global': counts, 'image_cooldown_remaining': cooldown}


def _preflight_inpaint_mask(parameters):
    """Reject masks whose exact generation-grid selection is empty."""
    source_value, mask_value = parameters.get('image'), parameters.get('mask')
    if not isinstance(source_value, str) or not isinstance(mask_value, str):
        raise HTTPException(422, '局部重绘需要有效的源图和蒙版')
    try:
        source_data = base64.b64decode(source_value, validate=True)
        mask_data = base64.b64decode(mask_value, validate=True)
        with Image.open(io.BytesIO(source_data)) as source:
            source_size = source.size
            if (source.format not in {'PNG', 'JPEG', 'WEBP'}
                    or source.width * source.height > MAX_IMAGE_PIXELS):
                raise ValueError('source')
    except Exception:
        raise HTTPException(422, '局部重绘源图或蒙版格式无效') from None

    cache_key = (hashlib.sha256(mask_value.encode('ascii')).digest(), source_size,
                 parameters.get('width'), parameters.get('height'))
    if cache_key in _mask_preflight_cache:
        error = _mask_preflight_cache[cache_key]
        _mask_preflight_cache.move_to_end(cache_key)
    else:
        try:
            validate_mask_selection(mask_data, source_size, parameters['width'], parameters['height'])
            error = None
        except ValueError as exc:
            error = str(exc)
        except Exception:
            error = '局部重绘蒙版格式无效'
        _mask_preflight_cache[cache_key] = error
        while len(_mask_preflight_cache) > MASK_PREFLIGHT_CACHE_MAX_ENTRIES:
            _mask_preflight_cache.popitem(last=False)
    if error:
        raise HTTPException(422, error)


def create_app(gate_url=None, transport=None, adapter_factory=NaiAdapter):
    gate_url = (gate_url or os.environ.get('WORKBENCH_GATE_URL', 'http://nai-gate:8000')).rstrip('/')
    static = Path(os.environ.get('WORKBENCH_STATIC_DIR', Path(__file__).resolve().parents[2]/'client/dist')).resolve()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    active = set()
    # Shared across Keys in this app only; the public snapshot never gates tasks.
    queue_status_lock = asyncio.Lock()
    queue_status_cache = {'expires_at': 0.0, 'data': None, 'failed': False}
    # Cache only the username returned by Gate's local identity endpoint. The
    # cache key is a digest, never the Gate Key itself. Generation continues to
    # authenticate directly with Gate on every request.
    identity_lock = asyncio.Lock()
    identity_cache = OrderedDict()
    identity_inflight = {}
    identity_lookup_events = deque()
    quote_rate_lock = asyncio.Lock()
    quote_global_events = deque()
    quote_key_events = OrderedDict()
    quote_slots = asyncio.Semaphore(QUOTE_MAX_CONCURRENCY)
    quote_parse_slots = asyncio.Semaphore(QUOTE_MAX_PARSE_CONCURRENCY)
    execute_prep_slots = asyncio.Semaphore(EXECUTE_PREP_MAX_CONCURRENCY)
    tag_slots = asyncio.Semaphore(TAG_MAX_CONCURRENCY)

    @app.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers.update({'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
                                 'Referrer-Policy':'no-referrer',
                                 'Content-Security-Policy':"frame-ancestors 'none'",
                                 'X-Frame-Options':'DENY'})
        return response

    def credential(request):
        raw = request.headers.get('authorization', '')
        if not raw.startswith('Bearer ') or not 1 <= len(raw[7:]) <= 512:
            raise HTTPException(401, '请填写 Gate 分配的 Key')
        return raw[7:]

    async def gate_get(path, token, *, timeout=15):
        async with httpx.AsyncClient(base_url=gate_url, timeout=timeout, follow_redirects=False, trust_env=False, transport=transport) as client:
            try:
                response = await client.get(path, headers={'Authorization':'Bearer '+token})
            except httpx.HTTPError:
                raise HTTPException(502, '暂时无法连接 Gate') from None
        if response.status_code != 200:
            raise HTTPException(response.status_code if response.status_code in (401,403,429) else 502,
                                {401:'Key 无效或已更换',403:'Key 已禁用或过期',429:'请求过于频繁'}.get(response.status_code, 'Gate 暂时不可用'))
        return response.json()

    async def gate_quote(token, query):
        try:
            async with httpx.AsyncClient(base_url=gate_url, timeout=30, follow_redirects=False,
                                        trust_env=False, transport=transport) as client:
                async with client.stream('POST', '/v1/image/quote', json=query,
                        headers={'Authorization': 'Bearer '+token}) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes(4096):
                        if len(raw) + len(chunk) > 65536:
                            raise HTTPException(502, 'Gate 报价响应过大')
                        raw.extend(chunk)
                    status = response.status_code
        except httpx.HTTPError:
            raise HTTPException(502, '暂时无法连接 Gate 获取报价') from None
        if status in (404, 405):
            raise HTTPException(503, 'Gate 尚未提供报价接口，请先更新 Gate')
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            raise HTTPException(502, 'Gate 报价响应无效') from None
        if status != 200:
            message = value.get('error', {}).get('message') if isinstance(value, dict) and isinstance(value.get('error'), dict) else None
            raise HTTPException(status if status in (400, 401, 402, 403, 409, 413, 422, 429) else 502,
                                message[:600] if isinstance(message, str) else 'Gate 暂时无法报价')
        names = ('anlas', 'v5', 'generation_anlas', 'encoding_anlas')
        if (not isinstance(value, dict) or value.get('source') != 'gate'
                or any(type(value.get(name)) not in (int, float) or not math.isfinite(value[name]) or value[name] < 0 for name in names)
                or (value['anlas'] > 0 and value['v5'] > 0)):
            raise HTTPException(502, 'Gate 返回的费用格式无效')
        for name in ('cost_limit', 'encoding_cost_limit'):
            limit = value.get(name)
            if (not isinstance(limit, dict) or set(limit) != {'anlas', 'v5'}
                    or any(type(n) not in (int, float) or not math.isfinite(n) or n < 0 for n in limit.values())):
                raise HTTPException(502, 'Gate 返回的费用上限无效')
        notes = value.get('notes', [])
        if not isinstance(notes, list) or any(not isinstance(note, str) for note in notes):
            raise HTTPException(502, 'Gate 返回的报价说明无效')
        v5 = value['v5'] > 0
        return {**value, 'units': value['v5'] if v5 else value['anlas'],
                'generation_units': value['v5'] if v5 else value['generation_anlas'],
                'encoding_units': value['encoding_anlas'], 'unit_label': 'V5单位' if v5 else '积分',
                'verified': False, 'message': '；'.join(notes) or 'Gate 当前报价；提交时复核费用。'}

    async def legacy_free_quota(token):
        # /v1/me reads Gate's local counters, not the official account. Older
        # Gate versions may omit the dedicated free-image counter: never use
        # total images instead, since those also include paid images and V5.
        try:
            info = await gate_get('/v1/me', token, timeout=4)
            today = info.get('today', {})
            limit, used = today.get('daily_images'), today.get('legacy_free_images_today')
            if any(type(value) is not int or value < 0 for value in (limit, used)):
                return None
            unlimited = info.get('is_admin') is True or limit == 0
            return dict(dailyLimit=limit, usedToday=used,
                        leftToday=max(0, limit-used), unlimited=unlimited)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                raise
        except (ValueError, TypeError, AttributeError):
            pass
        # Missing or temporarily unavailable counts must not prevent login,
        # and must not be presented as an unlimited allowance.
        return None

    async def fetch_gate_identity(digest, token, read_only=False):
        current = asyncio.current_task()
        try:
            info = await gate_get('/v1/image/quote' if read_only else '/user/information', token)
            username = info.get('username') if isinstance(info, dict) else None
            outcome = (200, username, '') if isinstance(username, str) else (502, None, 'Gate 暂时不可用')
        except HTTPException as exc:
            outcome = (exc.status_code, None, exc.detail)
        except asyncio.CancelledError:
            async with identity_lock:
                if identity_inflight.get(digest) is current:
                    identity_inflight.pop(digest, None)
            raise
        except Exception:
            outcome = (502, None, 'Gate 暂时不可用')

        async with identity_lock:
            if identity_inflight.get(digest) is current:
                identity_inflight.pop(digest, None)
            status, username, _ = outcome
            ttl = (GATE_IDENTITY_CACHE_TTL_SECONDS if status == 200 else
                   GATE_IDENTITY_FAILURE_CACHE_TTL_SECONDS if status in (401, 403) else 0)
            if ttl:
                identity_cache[digest] = (_security_now() + ttl, outcome)
                identity_cache.move_to_end(digest)
                while len(identity_cache) > GATE_IDENTITY_CACHE_MAX_ENTRIES:
                    identity_cache.popitem(last=False)
        return outcome

    async def gate_username(token, *, read_only=False):
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = _security_now()
        async with identity_lock:
            cached = identity_cache.get(digest)
            if cached is not None:
                if cached[0] > now:
                    identity_cache.move_to_end(digest)
                    outcome = cached[1]
                else:
                    identity_cache.pop(digest, None)
                    outcome = None
            else:
                outcome = None
            task = identity_inflight.get(digest)
            if outcome is None and task is None:
                _prune_window(identity_lookup_events, now, QUOTE_RATE_WINDOW_SECONDS)
                if len(identity_lookup_events) >= GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW:
                    raise HTTPException(429, '身份验证请求过多，请稍后再试', headers={'Retry-After': '60'})
                if len(identity_inflight) >= GATE_IDENTITY_LOOKUP_MAX_CONCURRENCY:
                    raise HTTPException(503, '身份验证暂时繁忙，请稍后再试', headers={'Retry-After': '1'})
                identity_lookup_events.append(now)
                task = asyncio.create_task(fetch_gate_identity(digest, token, read_only))
                identity_inflight[digest] = task

        if outcome is None:
            # Keep a canceled browser request from canceling a shared Gate lookup
            # needed by another quote or by /api/me.
            outcome = await asyncio.shield(task)
        status, username, detail = outcome
        if status != 200:
            raise HTTPException(status, detail)
        return username

    async def admit_quote(digest):
        now = _security_now()
        async with quote_rate_lock:
            _prune_window(quote_global_events, now, QUOTE_RATE_WINDOW_SECONDS)
            events = quote_key_events.get(digest)
            if events is None:
                events = deque()
            else:
                _prune_window(events, now, QUOTE_RATE_WINDOW_SECONDS)
            if (len(quote_global_events) >= QUOTE_GLOBAL_RATE_PER_WINDOW or
                    len(events) >= QUOTE_KEY_RATE_PER_WINDOW):
                raise HTTPException(429, '报价请求过多，请稍后再试', headers={'Retry-After': '60'})
            quote_global_events.append(now)
            events.append(now)
            quote_key_events[digest] = events
            quote_key_events.move_to_end(digest)
            while len(quote_key_events) > GATE_IDENTITY_CACHE_MAX_ENTRIES:
                quote_key_events.popitem(last=False)

    async def quote_task_bytes(request):
        declared_length = request.headers.get('content-length')
        if declared_length is not None:
            try:
                declared_length = int(declared_length)
            except ValueError:
                raise HTTPException(400, 'Content-Length 无效') from None
            if declared_length < 0:
                raise HTTPException(400, 'Content-Length 无效')
            if declared_length > QUOTE_MAX_BODY_BYTES:
                raise HTTPException(413, '报价请求体超过 25 MiB')
        raw = bytearray()
        try:
            async with asyncio.timeout(QUOTE_READ_TIMEOUT_SECONDS):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > QUOTE_MAX_BODY_BYTES:
                        raise HTTPException(413, '报价请求体超过 25 MiB')
                    raw.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, '读取报价请求超时') from None
        return raw

    def parse_quote_task(raw):
        try:
            task = validate_task(json.loads(raw), Settings())
        except (ValueError, TypeError, RecursionError, OverflowError):
            raise HTTPException(422, '任务参数无效') from None
        if task['operation'] not in OPERATIONS:
            raise HTTPException(422, '当前 Gate 尚未提供这项操作')
        return task

    async def task_body(request):
        raw = bytearray()
        try:
            async with asyncio.timeout(REQUEST_READ_TIMEOUT_SECONDS):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > 25*1024*1024:
                        raise HTTPException(413, '请求体超过 25 MiB')
                    raw.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, '读取任务请求超时') from None
        try:
            task = validate_task(json.loads(raw), Settings())
        except (ValueError, TypeError, RecursionError, OverflowError):
            raise HTTPException(422, '任务参数无效') from None
        if task['operation'] not in OPERATIONS:
            raise HTTPException(422, '当前 Gate 尚未提供这项操作')
        return task

    @app.get('/api/health')
    async def health():
        return {'ok':True, 'mode':'gate', 'queue':'browser', 'server_storage':False}

    @app.get('/api/queue-status')
    async def queue_status(request: Request):
        await gate_username(credential(request))
        now = _queue_status_now()
        if queue_status_cache['expires_at'] > now:
            if queue_status_cache['failed']:
                raise HTTPException(503, '队列状态暂不可用')
            return queue_status_cache['data']
        async with queue_status_lock:
            now = _queue_status_now()
            if queue_status_cache['expires_at'] > now:
                if queue_status_cache['failed']:
                    raise HTTPException(503, '队列状态暂不可用')
                return queue_status_cache['data']
            try:
                async with httpx.AsyncClient(base_url=gate_url, timeout=httpx.Timeout(4.0),
                        follow_redirects=False, trust_env=False, transport=transport) as client:
                    async with asyncio.timeout(4):
                        async with client.stream('GET', '/queue-status') as response:
                            if response.status_code != 200:
                                raise ValueError('Gate queue status unavailable')
                            body = bytearray()
                            async for chunk in response.aiter_bytes(chunk_size=4096):
                                if len(body) + len(chunk) > 16 * 1024:
                                    raise ValueError('Gate queue status too large')
                                body.extend(chunk)
                data = _queue_status_payload(json.loads(body))
                data['sampled_at'] = time.time()
            except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError, OverflowError, TimeoutError):
                # Cache failures briefly too; never relabel old counts as a fresh snapshot.
                queue_status_cache.update(expires_at=_queue_status_now() + 5, data=None, failed=True)
                raise HTTPException(503, '队列状态暂不可用') from None
            queue_status_cache.update(expires_at=_queue_status_now() + 5, data=data, failed=False)
            return data

    @app.get('/api/me')
    async def me(request: Request):
        token = credential(request)
        username = await gate_username(token)
        subscription = await gate_get('/user/subscription', token)
        quota = dict(subscription['naiGate'], legacyFree=await legacy_free_quota(token))
        return dict(id='gate-'+hashlib.sha256(token.encode()).hexdigest(), name=username, is_admin=False,
                    quota=dict(limit=quota['anlasMonthlyLimit'], used=0, reserved=0, remaining=quota['anlasLeft']),
                    gate_quota=quota, storage_policy=dict(mode='browser', retention_hours=0))

    @app.get('/api/capabilities')
    async def capabilities():
        return dict(models=MODELS, operations=OPERATIONS, mode='nai', backend='gate', live_verified=False)

    @app.post('/api/suggest-tags')
    async def suggest_tags(request: Request):
        """Forward only the active tag fragment to Gate's existing autocomplete."""
        token = credential(request)
        await gate_username(token)
        if tag_slots.locked():
            raise HTTPException(429, '标签查询繁忙，请稍后再试', headers={'Retry-After': '1'})
        await tag_slots.acquire()
        try:
            raw = bytearray()
            try:
                async with asyncio.timeout(REQUEST_READ_TIMEOUT_SECONDS):
                    async for chunk in request.stream():
                        if len(raw) + len(chunk) > 1024:
                            raise HTTPException(413, '标签查询过长')
                        raw.extend(chunk)
            except TimeoutError:
                raise HTTPException(408, '读取标签查询超时') from None
            try:
                body = json.loads(raw)
                prompt, model = body['prompt'], body['model']
            except (ValueError, TypeError, KeyError):
                raise HTTPException(422, '标签查询参数无效') from None
            if not isinstance(prompt, str) or not 2 <= len(prompt.strip()) <= 20 or not isinstance(model, str) or model not in {m['id'] for m in MODELS}:
                raise HTTPException(422, '标签查询参数无效')
            async with httpx.AsyncClient(base_url=gate_url, timeout=15, follow_redirects=False, trust_env=False, transport=transport) as client:
                try:
                    response = await client.post('/ai/generate-image/suggest-tags',
                        headers={'Authorization':'Bearer '+token}, json={'prompt':prompt.strip(),'model':model})
                except httpx.HTTPError:
                    raise HTTPException(502, '标签服务暂时不可用') from None
            if response.status_code != 200:
                status = response.status_code if response.status_code in (401, 403, 429, 503) else 502
                raise HTTPException(status, {401:'Key 无效或已更换',403:'Key 已禁用或过期',429:'标签查询过于频繁，请稍后再试',
                    503:'标签服务暂时不可用'}.get(status, '标签服务暂时不可用'))
            if len(response.content) > 512 * 1024:
                raise HTTPException(502, '标签结果过大')
            try:
                rows = response.json()['tags']
                if not isinstance(rows, list):
                    raise ValueError('tags')
                tags = [{'tag':row['tag'], 'count':row.get('count',0)} for row in rows[:20]
                        if isinstance(row, dict) and isinstance(row.get('tag'), str)
                        and 0 < len(row['tag']) <= 120 and isinstance(row.get('count',0), (int,float))]
            except (ValueError, TypeError, KeyError):
                raise HTTPException(502, '标签结果格式无效') from None
            return {'tags': tags}
        finally:
            tag_slots.release()

    @app.post('/api/quote')
    async def quote(request: Request):
        token = credential(request)
        if quote_slots.locked():
            raise HTTPException(429, '报价处理繁忙，请稍后再试', headers={'Retry-After': '1'})
        await quote_slots.acquire()
        try:
            digest = hashlib.sha256(token.encode()).hexdigest()
            await gate_username(token, read_only=True)
            await admit_quote(digest)
            raw = await quote_task_bytes(request)
            await quote_parse_slots.acquire()
            try:
                task = parse_quote_task(raw)
                if task['operation'] == 'inpaint':
                    _preflight_inpaint_mask(task['parameters'])
                try:
                    path, payload, _ = await asyncio.to_thread(build_request, task)
                except AdapterError as exc:
                    raise HTTPException(422, exc.message) from None
                operation = 'generate-image' if path.endswith('generate-image-stream') else path.rsplit('/', 1)[-1]
                query = dict(operation=operation, payload=payload,
                             pending_vibe_indices=task['parameters'].get('vibe_pending_indices', []))
            finally:
                quote_parse_slots.release()
            return await gate_quote(token, query)
        finally:
            quote_slots.release()

    @app.post('/api/execute')
    async def execute(request: Request):
        token = credential(request)
        owner = hashlib.sha256(token.encode()).hexdigest()
        def busy_error():
            reason = 'key_busy' if owner in active else 'service_busy'
            message = '同一 Key 有任务正在执行，请等待完成后再提交' if reason == 'key_busy' else '服务当前繁忙，请稍后重试'
            return dict(type='error', code='gate_busy', reason=reason, retryable=True, retry_after=15,
                        uncertain=False, message=message)

        if owner in active or len(active) >= 8 or execute_prep_slots.locked():
            return JSONResponse(busy_error(), status_code=429)
        await execute_prep_slots.acquire()
        try:
            # A failed Key is cached briefly and distinct lookups are bounded.
            # Gate checks the Key again when the actual image request arrives.
            try:
                await gate_username(token)
            except HTTPException as exc:
                if exc.status_code in (429, 503):
                    wait = 60 if exc.status_code == 429 else 15
                    return JSONResponse({**busy_error(), 'retry_after': wait}, status_code=429)
                raise
            task = await task_body(request)
        finally:
            execute_prep_slots.release()
        if owner in active or len(active) >= 8:
            return JSONResponse(busy_error(), status_code=429)
        async def events():
            if owner in active or len(active) >= 8:
                yield json.dumps(busy_error(), ensure_ascii=False)+'\n'
                return
            active.add(owner)
            adapter = None
            worker = None
            preview_received = False
            first_preview_seen = False
            first_preview = None
            latest_preview = None
            terminal = None
            ready = asyncio.Event()

            async def preview(value):
                nonlocal preview_received, first_preview_seen, first_preview, latest_preview
                preview_received = True
                item = dict(type='preview', preview=value)
                if not first_preview_seen:
                    first_preview_seen = True
                    first_preview = item
                    ready.set()
                    # Give the stream consumer one turn to take the first frame;
                    # never wait for it to finish sending before reading upstream.
                    await asyncio.sleep(0)
                else:
                    latest_preview = item
                    ready.set()

            async def run():
                nonlocal terminal
                try:
                    # Forward the checkbox value unchanged; an omitted value also means off.
                    artifacts = await adapter.execute(task, on_preview=preview)
                    terminal = dict(type='final', artifacts=[dict(data=base64.b64encode(a.data).decode(), media_type=a.media_type,
                        filename=a.filename, metadata=a.metadata, sha256=hashlib.sha256(a.data).hexdigest()) for a in artifacts])
                except AdapterError as error:
                    uncertain = error.uncertain or preview_received
                    retryable = error.retryable and not uncertain and error.code in {'gate_rpm', 'gate_cooldown', 'gate_busy'}
                    terminal = dict(type='error', code=error.code, retryable=retryable,
                                         retry_after=error.retry_after, uncertain=uncertain,
                                         message=error.message.replace('NAI', 'Gate') if not (error.retryable and uncertain)
                                         else '已收到生成预览，结果尚未确认，请先核对本次用量')
                except Exception:
                    terminal = dict(type='error', code='unknown', retryable=False, retry_after=None,
                                    uncertain=True, message='结果未能确认；未自动重试，请先核对用量')
                finally:
                    ready.set()

            try:
                adapter = adapter_factory(Settings(nai_base_url=gate_url, nai_token=token, upstream_timeout=330), gate_mode=True)
                worker = asyncio.create_task(run())
                while True:
                    await ready.wait()
                    ready.clear()
                    if terminal is not None:
                        # A completed result or error always outranks stale frames.
                        first_preview = None
                        latest_preview = None
                        item = terminal
                    elif first_preview is not None:
                        item = first_preview
                        first_preview = None
                    elif latest_preview is not None:
                        item = latest_preview
                        latest_preview = None
                    else:
                        continue
                    yield json.dumps(item, ensure_ascii=False)+'\n'
                    if item['type'] in ('final','error'):
                        break
            finally:
                try:
                    if worker is not None:
                        worker.cancel()
                        await asyncio.gather(worker, return_exceptions=True)
                finally:
                    try:
                        if adapter is not None:
                            await adapter.close()
                    finally:
                        active.discard(owner)
        return StreamingResponse(events(), media_type='application/x-ndjson')

    @app.get('/{path:path}')
    async def files(path: str):
        if path.startswith('api/'):
            raise HTTPException(404)
        target = (static / (path or 'index.html')).resolve()
        if not target.is_relative_to(static) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    return app


app = create_app()
