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
import re
import time
from collections import Counter, OrderedDict, deque
from pathlib import Path
from uuid import UUID

import anyio
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.staticfiles import StaticFiles

from .adapters import (AdapterError, NaiAdapter, QUEUE_ERRORS, QUEUE_REQUEST_HEADER,
                       QUEUE_TICKET_HEADER, queue_rejection)
from .config import Settings
from .model_policy import request_model_for_operation
from .task_validation import validate_task

OPERATIONS = ['generate', 'img2img', 'inpaint', 'encode_vibe', 'upscale', 'augment']
MODELS = [
    dict(id='nai-diffusion-4-5-full', name='NAI Diffusion V4.5 Full', max_characters=6, precise_reference=True, vibe_transfer=True),
    dict(id='nai-diffusion-4-5-curated', name='NAI Diffusion V4.5 Curated', max_characters=6, precise_reference=True, vibe_transfer=True),
    dict(id='nai-diffusion-5-full', name='NAI Diffusion V5 Full', max_characters=32, precise_reference=False, vibe_transfer=False),
    dict(id='nai-diffusion-5-full-medium', name='NAI Diffusion V5 Full Medium', max_characters=32, precise_reference=False, vibe_transfer=False),
    dict(id='nai-diffusion-5-curated', name='NAI Diffusion V5 Curated', max_characters=32, precise_reference=False, vibe_transfer=False),
    dict(id='nai-diffusion-4-full', name='NAI Diffusion V4 Full', max_characters=6, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-4-curated-preview', name='NAI Diffusion V4 Curated', max_characters=6, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-furry-3', name='NAI Diffusion Furry V3', max_characters=0, precise_reference=False, vibe_transfer=True),
    dict(id='nai-diffusion-3', name='NAI Diffusion V3', max_characters=0, precise_reference=False, vibe_transfer=True),
]

# Quote requests are informational only. Keep them separate from the image
# execution admission and retry policy below.
QUOTE_MAX_BODY_BYTES = 4 * 1024
QUOTE_READ_TIMEOUT_SECONDS = 30
QUOTE_RATE_WINDOW_SECONDS = 60
QUOTE_KEY_RATE_PER_WINDOW = 180
REQUEST_READ_TIMEOUT_SECONDS = 30
EXECUTE_PREP_MAX_CONCURRENCY = 8
TAG_MAX_CONCURRENCY = 8
GATE_IDENTITY_CACHE_TTL_SECONDS = 15
GATE_IDENTITY_FAILURE_CACHE_TTL_SECONDS = 2
GATE_IDENTITY_CACHE_MAX_ENTRIES = 256
GATE_IDENTITY_LOOKUP_MAX_CONCURRENCY = 4
GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW = 240
QUEUE_OPERATIONS = {'generate-image', 'upscale', 'augment-image', 'encode-vibe'}
QUEUE_STATES = {'queued', 'ready', 'active', 'finished', 'cancelled', 'expired'}


def _queue_uuid(value):
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError('invalid queue UUID')
    return str(UUID(value))


def _queue_failure(code):
    status, message, _, _ = QUEUE_ERRORS[code]
    return status, {'detail': message, 'error': {'status': status, 'message': message, 'code': code}, 'code': code}


def _queue_execution_failure(code):
    status, payload = _queue_failure(code)
    error = queue_rejection(payload)
    return JSONResponse(dict(type='error', code=code, message=error.message, retryable=error.retryable,
                             retry_after=error.retry_after, uncertain=error.uncertain), status_code=status)


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
    result = {'global': counts, 'image_cooldown_remaining': cooldown}
    if 'image_queue' in raw:
        image_queue = raw['image_queue']
        names = ('queued', 'ready', 'active', 'total', 'capacity')
        if (not isinstance(image_queue, dict)
                or any(type(image_queue.get(name)) is not int or image_queue[name] < 0 for name in names)):
            raise ValueError('invalid image queue snapshot')
        result['image_queue'] = {name: image_queue[name] for name in names}
    return result


def create_app(gate_url=None, transport=None, adapter_factory=NaiAdapter):
    gate_url = (gate_url or os.environ.get('WORKBENCH_GATE_URL', 'http://nai-gate:8000')).rstrip('/')
    static = Path(os.environ.get('WORKBENCH_STATIC_DIR', Path(__file__).resolve().parents[2]/'client/dist')).resolve()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    active = Counter()
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
    quote_key_events = OrderedDict()
    execute_prep_slots = asyncio.Semaphore(EXECUTE_PREP_MAX_CONCURRENCY)
    tag_slots = asyncio.Semaphore(TAG_MAX_CONCURRENCY)

    @app.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        path = request.url.path
        cache = 'no-store'
        if response.status_code in (200, 304):
            if path.startswith('/assets/'):
                cache = 'public, max-age=31536000, immutable'
            elif path.startswith(('/tokenizers/', '/fonts/')):
                cache = 'public, max-age=0, must-revalidate'
        response.headers.update({'Cache-Control':cache, 'X-Content-Type-Options':'nosniff',
                                 'Referrer-Policy':'no-referrer',
                                 'Content-Security-Policy':"frame-ancestors 'none'",
                                 'X-Frame-Options':'DENY'})
        return response

    def credential(request):
        raw = request.headers.get('authorization', '')
        if not raw.startswith('Bearer ') or not 1 <= len(raw[7:]) <= 512:
            raise HTTPException(401, '请填写 Gate 分配的 Key')
        return raw[7:]

    async def gate_queue(method, path, token, payload=None):
        try:
            async with httpx.AsyncClient(base_url=gate_url, timeout=5, follow_redirects=False,
                                        trust_env=False, transport=transport) as client:
                async with client.stream(method, '/v1/image/queue' + path, json=payload,
                                         headers={'Authorization': 'Bearer ' + token}) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes(4096):
                        if len(raw) + len(chunk) > 8192:
                            return _queue_failure('queue_unavailable')
                        raw.extend(chunk)
                    status = response.status_code
            value = json.loads(raw)
        except (httpx.HTTPError, ValueError, RecursionError):
            return _queue_failure('queue_unavailable')
        if status not in (200, 201):
            error = queue_rejection(value)
            if error:
                return _queue_failure(error.code)
            if status in (401, 403):
                return status, {'detail': 'Key 无效或已更换' if status == 401 else 'Key 已禁用或过期'}
            return _queue_failure('queue_unavailable')
        try:
            if not isinstance(value, dict) or value.get('state') not in QUEUE_STATES or value.get('operation') not in QUEUE_OPERATIONS:
                raise ValueError('invalid queue ticket')
            ticket_id, request_id = _queue_uuid(value.get('ticket_id')), _queue_uuid(value.get('request_id'))
            if (type(value.get('position')) is not int or value['position'] < 0
                    or any(type(value.get(name)) not in (int, float) or not math.isfinite(value[name]) or value[name] < 0
                           for name in ('expires_in', 'poll_after'))):
                raise ValueError('invalid queue ticket timing')
        except (ValueError, TypeError, AttributeError, OverflowError):
            return _queue_failure('queue_unavailable')
        return status, {**{name: value[name] for name in ('operation', 'state', 'position', 'expires_in', 'poll_after')},
                        'ticket_id': ticket_id, 'request_id': request_id}

    async def cancel_unsubmitted(queue, token):
        if queue is not None and not queue['submitted']:
            with anyio.CancelScope(shield=True):
                with anyio.move_on_after(3):
                    await gate_queue('DELETE', '/' + queue['ticket_id'], token)

    @app.post('/api/image-queue')
    async def create_queue_ticket(request: Request):
        token = credential(request)
        try:
            payload = json.loads(await quote_task_bytes(request, label='排队'))
            if (not isinstance(payload, dict) or not {'request_id', 'operation'} <= set(payload)
                    or set(payload) - {'request_id', 'operation', 'requires_anlas'}
                    or payload['operation'] not in QUEUE_OPERATIONS
                    or type(payload.get('requires_anlas', False)) is not bool):
                raise ValueError('invalid queue request')
            payload['request_id'] = _queue_uuid(payload['request_id'])
        except (ValueError, TypeError, RecursionError):
            status, value = _queue_failure('queue_invalid_request')
        else:
            status, value = await gate_queue('POST', '', token, payload)
        return JSONResponse(value, status_code=status)

    @app.api_route('/api/image-queue/{ticket_id}', methods=['GET', 'DELETE'])
    async def queue_ticket(request: Request, ticket_id: str):
        token = credential(request)
        try:
            ticket_id = _queue_uuid(ticket_id)
        except ValueError:
            status, value = _queue_failure('queue_invalid_request')
        else:
            status, value = await gate_queue(request.method, '/' + ticket_id, token)
        return JSONResponse(value, status_code=status)

    @app.post('/api/image-queue/{ticket_id}/heartbeat')
    async def heartbeat_queue_ticket(request: Request, ticket_id: str):
        token = credential(request)
        try:
            ticket_id = _queue_uuid(ticket_id)
        except ValueError:
            status, value = _queue_failure('queue_invalid_request')
        else:
            status, value = await gate_queue('POST', '/' + ticket_id + '/heartbeat', token)
        return JSONResponse(value, status_code=status)

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

    async def fetch_gate_identity(digest, token):
        current = asyncio.current_task()
        try:
            info = await gate_get('/user/information', token)
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

    async def gate_username(token):
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
                task = asyncio.create_task(fetch_gate_identity(digest, token))
                identity_inflight[digest] = task

        if outcome is None:
            # Keep a canceled browser request from canceling a shared Gate lookup
            # needed by another request or by /api/me.
            outcome = await asyncio.shield(task)
        status, username, detail = outcome
        if status != 200:
            raise HTTPException(status, detail)
        return username

    async def admit_quote(digest):
        now = _security_now()
        async with quote_rate_lock:
            events = quote_key_events.get(digest)
            if events is None:
                events = deque()
            else:
                _prune_window(events, now, QUOTE_RATE_WINDOW_SECONDS)
            if len(events) >= QUOTE_KEY_RATE_PER_WINDOW:
                raise HTTPException(429, '报价请求过多，请稍后再试', headers={'Retry-After': '60'})
            events.append(now)
            quote_key_events[digest] = events
            quote_key_events.move_to_end(digest)
            while len(quote_key_events) > GATE_IDENTITY_CACHE_MAX_ENTRIES:
                quote_key_events.popitem(last=False)

    async def quote_task_bytes(request, *, label='报价'):
        declared_length = request.headers.get('content-length')
        if declared_length is not None:
            try:
                declared_length = int(declared_length)
            except ValueError:
                raise HTTPException(400, 'Content-Length 无效') from None
            if declared_length < 0:
                raise HTTPException(400, 'Content-Length 无效')
            if declared_length > QUOTE_MAX_BODY_BYTES:
                raise HTTPException(413, label + '请求体超过 4 KiB')
        raw = bytearray()
        try:
            async with asyncio.timeout(QUOTE_READ_TIMEOUT_SECONDS):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > QUOTE_MAX_BODY_BYTES:
                        raise HTTPException(413, label + '请求体超过 4 KiB')
                    raw.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, '读取' + label + '请求超时') from None
        return raw

    def parse_quote_metadata(raw):
        try:
            query = json.loads(raw)
        except (ValueError, TypeError, RecursionError, OverflowError):
            raise HTTPException(422, '报价参数无效') from None
        if not isinstance(query, dict) or set(query) != {'operation', 'model', 'parameters'}:
            raise HTTPException(422, '报价仅接受 operation、model 和 parameters')
        operation, model, params = query['operation'], query['model'], query['parameters']
        if (not isinstance(model, str) or not 1 <= len(model) <= 160
                or not re.fullmatch(r'[A-Za-z0-9._-]+', model) or not isinstance(params, dict)):
            raise HTTPException(422, '报价模型或参数无效')
        fields = {
            'generate-image': {'mode', 'width', 'height', 'steps', 'n_samples', 'sm', 'sm_dyn',
                               'upscaled_enhance', 'has_controlnet', 'vibe_count', 'precise_count',
                               'pending_vibe_encoding_count', 'strength', 'inpaint_strength'},
            'upscale': {'width', 'height'},
            'augment-image': {'width', 'height', 'req_type'},
            'encode-vibe': set(),
        }
        if not isinstance(operation, str) or operation not in fields or set(params) - fields[operation]:
            raise HTTPException(422, '报价包含未知操作或非计价参数')
        for name, value in params.items():
            if name in {'sm', 'sm_dyn', 'upscaled_enhance', 'has_controlnet'}:
                valid = type(value) is bool
            elif name in {'mode', 'req_type'}:
                valid = isinstance(value, str) and 0 < len(value) <= 40
            elif name in {'strength', 'inpaint_strength'}:
                valid = type(value) is int or (type(value) is float and math.isfinite(value))
            else:
                valid = type(value) is int
            if not valid:
                raise HTTPException(422, '报价计价参数类型无效')
        if operation == 'generate-image':
            if params.get('n_samples', 1) != 1:
                raise HTTPException(422, '每个工作台任务只能生成一张图片')
            query['model'] = request_model_for_operation(model, params.get('mode', 'generate'))
            if (query['model'].startswith('nai-diffusion-4-5-') and not params.get('upscaled_enhance')
                    and (params.get('width', 832) % 64 or params.get('height', 1216) % 64)):
                raise HTTPException(422, '普通生成分辨率的宽高必须是 64 的整数倍')
        elif operation == 'upscale':
            query['model'] = 'nai-diffusion-5-curated'
        return query

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
        await admit_quote(hashlib.sha256(token.encode()).hexdigest())
        query = parse_quote_metadata(await quote_task_bytes(request))
        return await gate_quote(token, query)

    @app.post('/api/execute')
    async def execute(request: Request):
        token = credential(request)
        owner = hashlib.sha256(token.encode()).hexdigest()
        queue = None
        ticket_id = request.headers.get(QUEUE_TICKET_HEADER)
        queue_request_id = request.headers.get(QUEUE_REQUEST_HEADER)
        if ticket_id is not None or queue_request_id is not None:
            try:
                ticket_id, queue_request_id = _queue_uuid(ticket_id), _queue_uuid(queue_request_id)
            except ValueError:
                return _queue_execution_failure('queue_invalid_request')
            status, snapshot = await gate_queue('GET', '/' + ticket_id, token)
            if status not in (200, 201):
                error = queue_rejection(snapshot)
                return _queue_execution_failure(error.code) if error else JSONResponse(snapshot, status_code=status)
            if snapshot['ticket_id'] != ticket_id or snapshot['request_id'] != queue_request_id:
                return _queue_execution_failure('queue_ticket_mismatch')
            if snapshot['state'] != 'ready':
                code = {'queued': 'queue_ticket_not_ready', 'active': 'queue_ticket_used',
                        'finished': 'queue_ticket_used', 'cancelled': 'queue_ticket_cancelled',
                        'expired': 'queue_ticket_expired'}[snapshot['state']]
                return _queue_execution_failure(code)
            queue = {**snapshot, 'submitted': False}

        def busy_error():
            reason = 'key_busy' if owner in active else 'service_busy'
            message = '同一 Key 有任务正在执行，请等待完成后再提交' if reason == 'key_busy' else '服务当前繁忙，请稍后重试'
            return dict(type='error', code='gate_busy', reason=reason, retryable=True, retry_after=15,
                        uncertain=False, message=message)

        if queue is None and (owner in active or sum(active.values()) >= 8 or execute_prep_slots.locked()):
            return JSONResponse(busy_error(), status_code=429)
        try:
            async with execute_prep_slots:
                if queue is None:
                    # Unticketed clients retain the existing identity cache and admission.
                    try:
                        await gate_username(token)
                    except HTTPException as exc:
                        if exc.status_code in (429, 503):
                            wait = 60 if exc.status_code == 429 else 15
                            return JSONResponse({**busy_error(), 'retry_after': wait}, status_code=429)
                        raise
                task = await task_body(request)
                if queue is not None:
                    operation = {'generate': 'generate-image', 'img2img': 'generate-image',
                                 'inpaint': 'generate-image', 'upscale': 'upscale',
                                 'augment': 'augment-image', 'encode_vibe': 'encode-vibe'}[task['operation']]
                    if queue['operation'] != operation:
                        await cancel_unsubmitted(queue, token)
                        return _queue_execution_failure('queue_ticket_mismatch')
                    task['_gate_queue'] = queue
        except BaseException:
            await cancel_unsubmitted(queue, token)
            raise
        if queue is None and (owner in active or sum(active.values()) >= 8):
            return JSONResponse(busy_error(), status_code=429)
        async def events():
            if queue is None and (owner in active or sum(active.values()) >= 8):
                yield json.dumps(busy_error(), ensure_ascii=False)+'\n'
                return
            active[owner] += 1
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
                    retryable = error.retryable and not uncertain and error.code in ({'gate_rpm', 'gate_cooldown', 'gate_busy'} | QUEUE_ERRORS.keys())
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
                        active[owner] -= 1
                        if not active[owner]:
                            del active[owner]
                        await cancel_unsubmitted(queue, token)
        return StreamingResponse(events(), media_type='application/x-ndjson')

    for group in ('assets', 'tokenizers', 'fonts'):
        directory = static / group
        if directory.is_dir():
            app.mount('/' + group, GZipMiddleware(StaticFiles(directory=directory), minimum_size=1024, compresslevel=5), name=group)

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
