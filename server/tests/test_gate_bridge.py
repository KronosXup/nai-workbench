import asyncio
import json
import uuid

import httpx
import pytest

from app.adapters import AdapterError, Artifact, NaiAdapter
from app.config import Settings
from app.gate_bridge import create_app, estimate
import app.gate_bridge as gate_bridge


def task(model='nai-diffusion-4-5-full'):
    return dict(request_id=str(uuid.uuid4()), operation='generate', model=model, prompt='fixture', negative_prompt='', label='test',
                parameters=dict(width=832,height=1216,steps=28,scale=5,seed=1,n_samples=1))


def test_bridge_honors_stream_choice_through_gate_route_and_final_delivery():
    import base64
    import hashlib
    import io
    import zipfile
    from PIL import Image

    image = io.BytesIO()
    Image.new('RGB', (64, 64), 'navy').save(image, format='PNG')
    png = image.getvalue()
    encoded = base64.b64encode(png).decode()
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as output:
        output.writestr('image.png', png)
    paths = []

    async def gate(request):
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'fixture'})
        paths.append(request.url.path)
        if request.url.path == '/ai/generate-image-stream':
            payload = '\n\n'.join('event: ' + kind + '\ndata: ' + json.dumps({'image': encoded})
                                   for kind in ('preview', 'final')) + '\n\n'
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, text=payload)
        assert request.url.path == '/ai/generate-image'
        return httpx.Response(200, headers={'Content-Type': 'application/zip'}, content=archive.getvalue())

    transport = httpx.MockTransport(gate)
    def adapter(settings, *, gate_mode):
        return NaiAdapter(settings, transport, gate_mode=gate_mode)

    async def run():
        app = create_app('http://gate.fixture', transport, adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            # The unchecked UI omits stream until toggled: missing and explicit False both mean off.
            for operation in ('generate', 'img2img', 'inpaint'):
                for choice in (False, True, None):
                    body = task()
                    body['operation'] = operation
                    body['parameters'].update(width=64, height=64)
                    if operation != 'generate':
                        body['parameters']['image'] = encoded
                    if operation == 'inpaint':
                        body['parameters']['mask'] = encoded
                    if choice is not None:
                        body['parameters']['stream'] = choice
                    response = await client.post('/api/execute', headers={'Authorization': 'Bearer fixture'}, json=body)
                    assert response.status_code == 200
                    events = [json.loads(line) for line in response.text.splitlines()]
                    streaming = choice is True
                    assert paths[-1] == ('/ai/generate-image-stream' if streaming else '/ai/generate-image')
                    assert [event['type'] for event in events] == (['preview', 'final'] if streaming else ['final'])
                    artifact = events[-1]['artifacts'][0]
                    assert base64.b64decode(artifact['data']) == png
                    assert artifact['sha256'] == hashlib.sha256(png).hexdigest()
            assert len(paths) == 9
    asyncio.run(run())


def test_bridge_auth_isolation_operations_no_storage_and_stream():
    calls, tokens = [], []

    async def gate(request):
        calls.append(request.url.path)
        token = request.headers.get('authorization')
        if token not in ('Bearer A', 'Bearer B'):
            return httpx.Response(401)
        if request.url.path == '/user/information':
            return httpx.Response(200,json={'username':'same-name'})
        assert request.url.path == '/user/subscription'
        return httpx.Response(200,json={'naiGate':dict(anlasMonthlyLimit=30,anlasLeft=20,v5LeftToday=8,v5DailyLimit=10,v5Unlimited=False,imageModelScope='all')})

    class Adapter:
        def __init__(self, settings, *, gate_mode):
            assert settings.nai_base_url == 'http://gate.fixture'
            assert gate_mode is True
            tokens.append(settings.nai_token)
        async def execute(self, item, on_preview):
            if item['prompt'] == 'broken':
                raise AdapterError('broken','result uncertain',uncertain=True)
            await on_preview({'image':'fixture','media_type':'image/png'})
            return [Artifact(b'fixture',metadata={'isolated':True})]
        async def close(self):
            pass

    async def run():
        app = create_app('http://gate.fixture',httpx.MockTransport(gate),Adapter)
        assert not hasattr(app.state,'store') and not hasattr(app.state,'service')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.get('/api/health')).json()['queue'] == 'browser'
            assert (await client.get('/api/me')).status_code == 401
            assert (await client.post('/api/execute',json=task())).status_code == 401
            assert (await client.get('/api/me',headers={'Authorization':'Bearer invalid'})).status_code == 401
            users = []
            for token in ('A','B'):
                headers = {'Authorization':'Bearer '+token}
                me = await client.get('/api/me',headers=headers)
                assert me.headers['cache-control'] == 'no-store'
                users.append(me.json()['id'])
                response = await client.post('/api/execute',headers=headers,json=task())
                events = [json.loads(line) for line in response.text.splitlines()]
                assert [e['type'] for e in events] == ['preview','final']
                assert events[-1]['artifacts'][0]['data'] == 'Zml4dHVyZQ=='
            assert users[0] != users[1] and tokens == ['A','B']
            assert (await client.get('/api/results/other/content',headers={'Authorization':'Bearer B'})).status_code == 404
            body = task(); body['prompt']='broken'
            response=await client.post('/api/execute',headers={'Authorization':'Bearer A'},json=body)
            assert response.json()['type'] == 'error' and response.json()['uncertain']
            body=task(); body['operation']='upscale'; body['parameters']['image']='Zml4dHVyZQ=='
            assert (await client.post('/api/execute',headers={'Authorization':'Bearer A'},json=body)).status_code == 200
            body['operation']='unsupported'
            assert (await client.post('/api/execute',headers={'Authorization':'Bearer A'},json=body)).status_code == 422
            before=len(calls)
            q=await client.post('/api/quote',headers={'Authorization':'Bearer A'},json=task())
            assert q.json()['units']==0 and len(calls)==before
            assert (await client.get('/api/admin/users')).status_code==404
            assert (await client.get('/server/app/config.py')).status_code==404
    asyncio.run(run())


def test_quotes_use_gate_units_and_reference_surcharges():
    assert estimate(task())['units']==0
    q=estimate(task('nai-diffusion-5-full'))
    assert q['units']==1 and q['unit_label']=='V5次数' and not q['verified']
    item=task('nai-diffusion-5-full');item['parameters']['steps']=29
    assert estimate(item)['units']==30 and estimate(item)['unit_label']=='积分'
    item=task();item['parameters']['character_reference_images']=['fixture']
    assert estimate(item)['units']==5


def test_v5_curated_is_listed_quoted_and_forwarded_as_curated():
    from app.adapters import build_request

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: httpx.Response(500)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            models = (await client.get('/api/capabilities')).json()['models']
            curated = next(model for model in models if model['id'] == 'nai-diffusion-5-curated')
            assert not curated['precise_reference'] and not curated['vibe_transfer']
    asyncio.run(run())
    item = task('nai-diffusion-5-curated')
    assert estimate(item)['unit_label'] == 'V5次数'
    _, body, _ = build_request(item)
    assert body['model'] == 'nai-diffusion-5-curated'
    item['parameters']['steps'] = 29
    assert estimate(item)['unit_label'] == '积分'


def test_v5_curated_inpaint_maps_request_and_uses_v45_quote_classification():
    import base64
    import io
    from PIL import Image
    from app.adapters import build_request

    image = io.BytesIO()
    Image.new('RGB', (64, 64), 'navy').save(image, format='PNG')
    encoded = base64.b64encode(image.getvalue()).decode()
    item = task('nai-diffusion-5-curated')
    item['operation'] = 'inpaint'
    item['parameters'].update(image=encoded, mask=encoded, width=256, height=256, steps=29,
                              img2img={'strength': .2})
    quote = estimate(item)
    assert (quote['units'], quote['generation_units'], quote['unit_label']) == (2, 2, '积分')
    _, body, _ = build_request(item)
    assert (body['model'], body['action']) == ('nai-diffusion-4-5-curated-inpainting', 'infill')
    with_precise = {**item, 'parameters': {**item['parameters'], 'character_reference_images': [encoded]}}
    _, precise_body, _ = build_request(with_precise)
    assert len(precise_body['parameters']['director_reference_images_cached']) == 1
    assert 'character_reference_images' not in precise_body['parameters']

    # An ordinary V5 request remains on the V5 endpoint/model and daily quota.
    for operation in ('generate', 'img2img'):
        ordinary = task('nai-diffusion-5-curated')
        ordinary['operation'] = operation
        ordinary['parameters'].update(width=512, height=512)
        if operation == 'img2img':
            ordinary['parameters']['image'] = encoded
        ordinary_quote = estimate(ordinary)
        assert ordinary_quote['unit_label'] == 'V5次数'
        _, ordinary_body, _ = build_request(ordinary)
        assert ordinary_body['model'] == 'nai-diffusion-5-curated'
        assert ordinary_body['action'] == operation

    # The V4.5-mapped inpaint free case is still reported as credits, not V5 use.
    item['parameters'].update(width=512, height=512, steps=28, img2img={'strength': .2})
    free_quote = estimate(item)
    assert (free_quote['units'], free_quote['unit_label']) == (0, '积分')


def test_v5_curated_inpaint_quote_counts_v45_vibe_encoding_units():
    item = task('nai-diffusion-5-curated')
    item['operation'] = 'inpaint'
    item['parameters'].update(width=256, height=256, steps=29, image='fixture', mask='fixture',
                              img2img={'strength': .2}, reference_image_multiple=['encoded-vibe'],
                              vibe_pending_indices=[0])
    quote = estimate(item)
    assert quote['unit_label'] == '积分'
    assert quote['encoding_units'] == 2 and quote['generation_units'] == 2 and quote['units'] == 4


def test_tag_suggestions_forward_only_a_bounded_fragment_and_do_not_generate():
    calls = []
    async def gate(request):
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'fixture'})
        calls.append((request.method, request.url.path, request.headers.get('authorization'), json.loads(request.content)))
        return httpx.Response(200, json={'tags':[{'tag':'blue sky','count':123},{'tag':'sunset','count':7}]})
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            headers={'Authorization':'Bearer fixture'}
            assert (await client.post('/api/suggest-tags',json={'prompt':'blue','model':'nai-diffusion-5-full'})).status_code == 401
            assert (await client.post('/api/suggest-tags',headers=headers,json={'prompt':'x','model':'nai-diffusion-5-full'})).status_code == 422
            assert (await client.post('/api/suggest-tags',headers=headers,json={'prompt':'blue','model':'unknown'})).status_code == 422
            response=await client.post('/api/suggest-tags',headers=headers,json={'prompt':'blue','model':'nai-diffusion-5-full'})
            assert response.status_code == 200 and response.json()['tags'][0]['tag'] == 'blue sky'
        assert calls == [('POST','/ai/generate-image/suggest-tags','Bearer fixture',{'prompt':'blue','model':'nai-diffusion-5-full'})]
    asyncio.run(run())


def test_chunked_input_is_bounded_without_upstream_generation():
    async def gate(request):
        return httpx.Response(200,json={'username':'fixture'})
    async def run():
        app=create_app('http://fixture',httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            async def chunks():
                for _ in range(26): yield b'x'*(1024*1024)
            response=await client.post('/api/execute',headers={'Authorization':'Bearer A'},content=chunks())
            assert response.status_code==413
    asyncio.run(run())


def test_tools_use_actual_image_size_and_vibe_quote_is_once():
    import base64
    import io
    from PIL import Image
    from app.adapters import build_request
    stream=io.BytesIO();Image.new('RGB',(640,480)).save(stream,format='PNG')
    image=base64.b64encode(stream.getvalue()).decode()
    item=task();item['parameters'].update(image=image,width=1024,height=1024,scale_factor=2)
    item['operation']='upscale'
    assert estimate(item)['units']==1
    path,body,streaming=build_request(item)
    assert path=='/ai/upscale' and body==dict(image=image,model='nai-diffusion-5-curated',declared_blur_sigma=0) and not streaming
    item['operation']='augment';item['parameters'].update(req_type='emotion',emotion='happy',defry=2)
    path,body,_=build_request(item)
    assert path=='/ai/augment-image' and body['width']==640 and body['height']==480
    assert body['prompt']=='happy;;fixture' and body['defry']==2
    assert estimate(item)['units']==0
    item['parameters']['req_type']='bg-removal'
    assert estimate(item)['units']==65
    item=task();item['parameters'].update(reference_image_multiple=['a','b'],vibe_pending_indices=[0,1])
    q=estimate(item)
    assert q['units']==4 and q['encoding_units']==4 and q['generation_units']==0
    item['parameters']['vibe_pending_indices']=[]
    assert estimate(item)['units']==0


@pytest.mark.parametrize('information,encoding_units', [([1, 1, 1, 1, 1], 2), ([1, 1, .5, .5, .5], 4)])
def test_repeated_vibe_sources_share_encoding_but_keep_reference_entry_surcharge(information, encoding_units):
    item = task()
    item['parameters'].update(reference_image_multiple=['same-source'] * 5,
                              reference_information_extracted_multiple=information,
                              vibe_pending_indices=[0, 1, 2, 3, 4])
    quote = estimate(item)
    assert quote['encoding_units'] == encoding_units
    assert quote['generation_units'] == 2  # Five reference entries remain five.
    assert quote['units'] == encoding_units + 2


@pytest.mark.parametrize('model', ['nai-diffusion-4-full', 'nai-diffusion-4-5-full'])
def test_legacy_free_quote_uses_area_and_keeps_paid_features(model):
    item = task(model)
    for width, height in [(512, 768), (896, 1152), (2048, 512), (1024, 1024)]:
        item['parameters'].update(width=width, height=height)
        quote = estimate(item)
        assert quote['units'] == 0 and quote['unit_label'] == '积分' and not quote['verified']
    item['parameters']['height'] = 1032
    assert estimate(item)['units'] == 21
    for parameter in [dict(steps=29), dict(controlnet_model='fixture')]:
        item = task(model)
        item['parameters'].update(parameter)
        assert estimate(item)['units'] > 0
    item = task(model)
    item['operation'] = 'img2img'
    item['parameters'].update(image='fixture', strength=.5)
    assert estimate(item)['units'] == 0
    item['parameters']['steps'] = 29
    assert estimate(item)['units'] == 10
    item = task(model)
    item['parameters'].update(width=512, height=768, reference_image_multiple=['a'] * 5)
    assert estimate(item)['units'] == 2


def test_reference_quotes_keep_free_base_and_v5_uses_pixel_area():
    item = task()
    item['parameters'].update(width=512, height=768, character_reference_images=['fixture'])
    assert estimate(item)['units'] == 5
    item = task('nai-diffusion-5-full')
    item['parameters'].update(width=896, height=1152)
    assert estimate(item)['units'] == 1 and estimate(item)['unit_label'] == 'V5次数'
    item['parameters'].update(width=512, height=768)
    assert estimate(item)['units'] == 1 and estimate(item)['unit_label'] == 'V5次数'


def test_img2img_and_inpaint_quotes_match_gate_billing_rules():
    for operation in ('img2img', 'inpaint'):
        for model in ('nai-diffusion-4-5-full', 'nai-diffusion-5-full'):
            item = task(model)
            item['operation'] = operation
            item['parameters'].update(image='fixture', width=512, height=512, steps=28, strength=.6)
            quote = estimate(item)
            assert (quote['units'], quote['unit_label']) == ((1, 'V5次数') if 'diffusion-5' in model else (0, '积分'))
            item['parameters']['steps'] = 29
            if operation == 'inpaint':
                assert estimate(item)['units'] == (9 if 'diffusion-5' in model else 6)
                item['parameters']['img2img'] = {'strength': .6}
            expected = (9 if operation == 'inpaint' else 6) if 'diffusion-5' in model else 4
            assert estimate(item)['units'] == expected


@pytest.mark.parametrize('message,flat,header,code,delay', [
    ('请求过于频繁（上限 2 次/分钟），请稍后再试', False, None, 'gate_rpm', 60),
    ('请求过于频繁（上限 2 次/分钟），请稍后再试', False, '42', 'gate_rpm', 42),
    ('上游图片服务限流保护中，所有图片生成暂停约 125 秒', True, None, 'gate_cooldown', 125),
    ('上游图片服务限流保护中，所有图片生成暂停约 125 秒', False, '150', 'gate_cooldown', 150),
    ('当前排队人数过多，请稍后再试', True, None, 'gate_busy', 60),
])
def test_gate_pre_dispatch_waits_have_safe_retry_protocol(message, flat, header, code, delay):
    calls = []
    payload = dict(error=message, message=message) if flat else dict(error=dict(message=message, status=429))
    payload['echoed_input'] = 'private-prompt test-only-token'
    async def run():
        def handler(request):
            calls.append(request)
            return httpx.Response(429, json=payload, headers={'Retry-After': header} if header else {})
        adapter = NaiAdapter(Settings(nai_token='test-only-token'), httpx.MockTransport(handler), gate_mode=True)
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(task())
            error = caught.value
            assert error.code == code and error.retryable and not error.uncertain and error.retry_after == delay
            assert 'private-prompt' not in str(error) and 'test-only-token' not in str(error)
            assert len(calls) == 1  # Waiting/retrying belongs to the browser queue.
        finally:
            await adapter.close()
    asyncio.run(run())


@pytest.mark.parametrize('status,message,gate_mode', [
    (429, '已达今日 V5 额度（10 张/天），明天恢复后再用', True),
    (429, '上游限流(429)，全站图片生成已进入冷却', True),
    (429, 'unknown private-prompt test-only-token', True),
    (429, '请求过于频繁（上限 2 次/分钟），请稍后再试 private-prompt', True),
    (429, '请求过于频繁（上限 2 次/分钟），请稍后再试', False),
    (402, '请求过于频繁（上限 2 次/分钟），请稍后再试', True),
    (403, '请求过于频繁（上限 2 次/分钟），请稍后再试', True),
])
def test_quota_unknown_upstream_and_generic_nai_errors_never_resume(status, message, gate_mode):
    async def run():
        adapter = NaiAdapter(Settings(nai_token='test-only-token'),
                             httpx.MockTransport(lambda _: httpx.Response(status, json={'error': {'message': message, 'status': status}})),
                             gate_mode=gate_mode)
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(task())
            assert not caught.value.retryable
            assert 'private-prompt' not in str(caught.value) and 'test-only-token' not in str(caught.value)
        finally:
            await adapter.close()
    asyncio.run(run())


def test_gate_error_diagnostic_body_is_bounded():
    async def run():
        payload = dict(error=dict(message='请求过于频繁（上限 2 次/分钟），请稍后再试', status=429), echo='secret' * 2048)
        adapter = NaiAdapter(Settings(nai_token='fixture'), httpx.MockTransport(lambda _: httpx.Response(429, json=payload)), gate_mode=True)
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(task())
            assert not caught.value.retryable and 'secret' not in str(caught.value)
        finally:
            await adapter.close()
    asyncio.run(run())


@pytest.mark.parametrize('has_preview', [False, True])
def test_bridge_preserves_retry_metadata_but_never_retries_after_a_preview(has_preview):
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            assert gate_mode
        async def execute(self, item, on_preview):
            if has_preview:
                await on_preview(dict(image='fixture', media_type='image/png'))
            raise AdapterError('gate_rpm', '等待后自动继续', retry_after=60, retryable=True)
        async def close(self):
            pass
    async def run():
        app = create_app('http://fixture', httpx.MockTransport(lambda _: httpx.Response(200, json={'username': 'fixture'})), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            response = await client.post('/api/execute', headers={'Authorization': 'Bearer A'}, json=task())
            events = [json.loads(line) for line in response.text.splitlines()]
            error = events[-1]
            assert error['code'] == 'gate_rpm' and error['retry_after'] == 60
            assert error['retryable'] is not has_preview and error['uncertain'] is has_preview
            assert len(events) == (2 if has_preview else 1)
    asyncio.run(run())


def test_busy_browser_bridge_reports_a_retryable_wait_without_starting_another_job():
    async def run():
        started, release = asyncio.Queue(), asyncio.Event()
        class Adapter:
            def __init__(self, settings, *, gate_mode):
                pass
            async def execute(self, item, on_preview):
                started.put_nowait(True)
                await release.wait()
                return [Artifact(b'fixture')]
            async def close(self):
                pass
        def gate(request):
            if request.url.path == '/user/subscription':
                return httpx.Response(200, json={'naiGate': {'anlasMonthlyLimit': 100, 'anlasLeft': 100}})
            return httpx.Response(200, json={'username': 'fixture'})
        app = create_app('http://fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            # A signed-in browser has already checked its Key; warm that cache
            # before testing all eight concurrent generation slots.
            for key in 'ABCDEFGH':
                assert (await client.get('/api/me', headers={'Authorization': f'Bearer {key}'})).status_code == 200
            first = [asyncio.create_task(client.post('/api/execute', headers={'Authorization': f'Bearer {key}'}, json=task()))
                     for key in 'ABCDEFGH']
            try:
                for _ in first:
                    await asyncio.wait_for(started.get(), 2)
                same_key = await client.post('/api/execute', headers={'Authorization': 'Bearer A'}, json=task())
                assert same_key.status_code == 429
                assert same_key.json()['code'] == 'gate_busy' and same_key.json()['reason'] == 'key_busy'
                other_key = await client.post('/api/execute', headers={'Authorization': 'Bearer I'}, json=task())
                assert other_key.status_code == 429
                assert other_key.json()['code'] == 'gate_busy' and other_key.json()['reason'] == 'service_busy'
                for response in (same_key, other_key):
                    assert response.json()['retryable'] is True
                    assert response.json()['uncertain'] is False and response.json()['retry_after'] == 15
                assert started.empty()  # Rejections did not submit another generation.
            finally:
                release.set()
                await asyncio.gather(*first)
    asyncio.run(run())


def test_queue_status_is_authenticated_cached_whitelisted_and_failure_safe(monkeypatch):
    async def run():
        now = [100.0]
        monkeypatch.setattr(gate_bridge, '_queue_status_now', lambda: now[0])
        calls = []
        mode = ['valid']
        entered, release = asyncio.Event(), asyncio.Event()

        async def gate(request):
            if request.url.path == '/user/information':
                return httpx.Response(200, json={'username': 'fixture'})
            assert request.url.path == '/queue-status'
            assert request.headers.get('authorization') is None
            calls.append(request)
            if mode[0] == 'blocked':
                entered.set()
                await release.wait()
                return httpx.Response(200, json={'global': {'active': 2, 'waiting': 3, 'concurrency': 8, 'private': 'hidden'},
                                                  'image_cooldown_remaining': 1.5, 'private': 'hidden'})
            if mode[0] == 'valid':
                return httpx.Response(200, json={'global': {'active': 1, 'waiting': 4, 'concurrency': 8, 'private': 'hidden'},
                                                  'image_cooldown_remaining': 0, 'private': 'hidden'})
            if mode[0] == 'invalid':
                return httpx.Response(200, json={'global': {'active': 1, 'waiting': 0, 'concurrency': 0},
                                                  'image_cooldown_remaining': 0})
            if mode[0] == 'large':
                return httpx.Response(200, content=b' ' * (16 * 1024 + 1))
            return httpx.Response(502, json={'private': 'hidden'})

        app = create_app('http://fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            assert (await client.get('/api/queue-status')).status_code == 401
            assert calls == []
            headers_a, headers_b = {'Authorization': 'Bearer A'}, {'Authorization': 'Bearer B'}
            mode[0] = 'blocked'
            first = asyncio.create_task(client.get('/api/queue-status', headers=headers_a))
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(client.get('/api/queue-status', headers=headers_b))
            await asyncio.sleep(0)
            release.set()
            a, b = await asyncio.gather(first, second)
            assert a.status_code == b.status_code == 200 and len(calls) == 1
            snapshot = a.json()
            assert set(snapshot) == {'global', 'image_cooldown_remaining', 'sampled_at'}
            assert snapshot['global'] == {'active': 2, 'waiting': 3, 'concurrency': 8}
            assert snapshot['image_cooldown_remaining'] == 1.5 and snapshot['sampled_at'] > 0
            assert a.json()['sampled_at'] == b.json()['sampled_at']

            # Cache hits last five seconds, then refresh from Gate.
            mode[0] = 'valid'
            assert (await client.get('/api/queue-status', headers=headers_a)).json() == snapshot
            assert len(calls) == 1
            now[0] = 105.01
            refreshed = await client.get('/api/queue-status', headers=headers_a)
            assert refreshed.status_code == 200 and refreshed.json()['global']['active'] == 1
            assert len(calls) == 2

            # Failure samples are cached too, but old counts are never returned as current.
            mode[0] = 'failed'; now[0] = 111
            failed = await client.get('/api/queue-status', headers=headers_a)
            assert failed.status_code == 503 and 'global' not in failed.json()
            assert (await client.get('/api/queue-status', headers=headers_b)).status_code == 503
            assert len(calls) == 3
            now[0] = 116.01
            assert (await client.get('/api/queue-status', headers=headers_a)).status_code == 503
            assert len(calls) == 4

            mode[0] = 'invalid'; now[0] = 122
            assert (await client.get('/api/queue-status', headers=headers_a)).status_code == 503
            mode[0] = 'large'; now[0] = 128
            assert (await client.get('/api/queue-status', headers=headers_a)).status_code == 503
            assert len(calls) == 6
    asyncio.run(run())


def test_queue_status_cache_isolated_between_app_instances():
    async def run():
        calls = {'one': 0, 'two': 0}
        async def gate(name, active):
            async def handle(request):
                if request.url.path == '/user/information':
                    return httpx.Response(200, json={'username': name})
                assert request.url.path == '/queue-status'
                calls[name] += 1
                return httpx.Response(200, json={'global': {'active': active, 'waiting': 0, 'concurrency': 8},
                                                  'image_cooldown_remaining': 0})
            return handle
        app_one = create_app('http://one.fixture', httpx.MockTransport(await gate('one', 1)))
        app_two = create_app('http://two.fixture', httpx.MockTransport(await gate('two', 2)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_one), base_url='http://test') as one, \
                   httpx.AsyncClient(transport=httpx.ASGITransport(app=app_two), base_url='http://test') as two:
            headers = {'Authorization': 'Bearer fixture'}
            first = await one.get('/api/queue-status', headers=headers)
            second = await two.get('/api/queue-status', headers=headers)
            assert first.status_code == second.status_code == 200
            assert first.json()['global']['active'] == 1 and second.json()['global']['active'] == 2
            assert calls == {'one': 1, 'two': 1}
    asyncio.run(run())


def test_gate_sse_error_is_never_treated_as_a_pre_dispatch_wait():
    async def run():
        payload = dict(event_type='error', error='当前排队人数过多，请稍后再试', message='当前排队人数过多，请稍后再试', status_code=429)
        adapter = NaiAdapter(Settings(nai_token='fixture'), httpx.MockTransport(lambda _: httpx.Response(
            200, headers={'Content-Type': 'text/event-stream'}, text='event: error\ndata: ' + json.dumps(payload) + '\n\n')), gate_mode=True)
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(task())
            assert caught.value.uncertain and not caught.value.retryable
        finally:
            await adapter.close()
    asyncio.run(run())


def test_stream_returns_on_valid_final_even_when_upstream_never_closes():
    import base64
    import io
    from PIL import Image

    image = io.BytesIO()
    Image.new('RGB', (24, 24), 'navy').save(image, format='PNG')
    encoded = base64.b64encode(image.getvalue()).decode()
    payload = ('event: final\ndata: ' + json.dumps({'image': encoded, 'final': True}) + '\n\n').encode()

    class OpenStream(httpx.AsyncByteStream):
        def __init__(self):
            self.release = asyncio.Event()
            self.closed = False

        async def __aiter__(self):
            yield payload
            await self.release.wait()

        async def aclose(self):
            self.closed = True
            self.release.set()

    async def run():
        stream = OpenStream()
        adapter = NaiAdapter(Settings(nai_token='fixture'), httpx.MockTransport(
            lambda _: httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, stream=stream)))
        item = task()
        item['parameters']['stream'] = True
        execution = asyncio.create_task(adapter.execute(item))
        try:
            done, _ = await asyncio.wait({execution}, timeout=1)
            assert execution in done, 'valid final image did not finish while upstream stayed open'
            artifacts = execution.result()
            assert len(artifacts) == 1 and artifacts[0].data == image.getvalue()
            assert stream.closed
        finally:
            if not execution.done():
                execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
            await adapter.close()
    asyncio.run(run())


@pytest.mark.parametrize('kind,payload', [
    ('preview', {'final': False}),
    ('final', {'final': True, 'image': 'bm90IGFuIGltYWdl'}),
])
def test_stream_preview_only_or_corrupt_final_never_completes(kind, payload):
    import base64
    import io
    from PIL import Image

    image = io.BytesIO()
    Image.new('RGB', (24, 24), 'navy').save(image, format='PNG')
    if kind == 'preview':
        payload['image'] = base64.b64encode(image.getvalue()).decode()
    body = ('event: ' + kind + '\ndata: ' + json.dumps(payload) + '\n\n')
    if kind == 'preview':
        body += 'data: [DONE]\n\n'

    async def run():
        adapter = NaiAdapter(Settings(nai_token='fixture'), httpx.MockTransport(
            lambda _: httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, text=body)))
        item = task()
        item['parameters']['stream'] = True
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(item)
            assert caught.value.uncertain
        finally:
            await adapter.close()
    asyncio.run(run())


def _execute_scope(body, token='fixture'):
    return {
        'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.3'},
        'http_version': '1.1', 'method': 'POST', 'scheme': 'http', 'path': '/api/execute',
        'raw_path': b'/api/execute', 'query_string': b'',
        'headers': [(b'authorization', ('Bearer ' + token).encode())],
        'client': ('test', 123), 'server': ('test', 80), 'root_path': '',
    }


def test_bridge_slow_consumer_coalesces_previews_and_receives_terminal():
    async def run():
        callbacks_returned = asyncio.Event()

        class Adapter:
            def __init__(self, settings, *, gate_mode):
                self.closed = False

            async def execute(self, item, on_preview):
                for index in range(8):
                    await on_preview({'image': str(index), 'media_type': 'image/png'})
                callbacks_returned.set()
                return [Artifact(b'complete')]

            async def close(self):
                self.closed = True

        app = create_app('http://fixture', httpx.MockTransport(
            lambda _: httpx.Response(200, json={'username': 'fixture'})), Adapter)
        request_body = json.dumps(task()).encode()
        request_sent = False
        first_send_started, release_first_send = asyncio.Event(), asyncio.Event()
        events, statuses = [], []

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {'type': 'http.request', 'body': request_body, 'more_body': False}
            await asyncio.Event().wait()

        async def send(message):
            if message['type'] == 'http.response.start':
                statuses.append(message['status'])
            elif message['type'] == 'http.response.body' and message.get('body'):
                event = json.loads(message['body'])
                events.append(event)
                if len(events) == 1:
                    first_send_started.set()
                    await release_first_send.wait()

        request = asyncio.create_task(app(_execute_scope(task()), receive, send))
        try:
            await asyncio.wait_for(first_send_started.wait(), timeout=1)
            first = events[0]
            assert first['type'] == 'preview' and first['preview']['image'] == '0'
            # Keep ASGI send blocked on the first preview while the adapter reads
            # all remaining frames and returns its final artifact.
            await asyncio.wait_for(callbacks_returned.wait(), timeout=0.5)
            assert first_send_started.is_set() and callbacks_returned.is_set()
            release_first_send.set()
            done, _ = await asyncio.wait({request}, timeout=1)
            assert request in done
            await request
            assert events[-1]['type'] == 'final'
            assert sum(event['type'] == 'preview' for event in events) <= 2
        finally:
            release_first_send.set()
            if not request.done():
                request.cancel()
            await asyncio.gather(request, return_exceptions=True)
    asyncio.run(run())


def test_bridge_disconnect_cancels_worker_closes_adapter_and_releases_key():
    async def run():
        started, cancelled = asyncio.Event(), asyncio.Event()
        instances = []

        class Adapter:
            def __init__(self, settings, *, gate_mode):
                self.index = len(instances)
                self.closed = False
                instances.append(self)

            async def execute(self, item, on_preview):
                if self.index == 0:
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
                return [Artifact(b'complete')]

            async def close(self):
                self.closed = True

        app = create_app('http://fixture', httpx.MockTransport(
            lambda _: httpx.Response(200, json={'username': 'fixture'})), Adapter)
        request_body = json.dumps(task()).encode()
        request_sent = False

        async def receive_disconnect():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {'type': 'http.request', 'body': request_body, 'more_body': False}
            await started.wait()
            return {'type': 'http.disconnect'}

        async def send_first(message):
            pass

        disconnected = asyncio.create_task(app(_execute_scope(task()), receive_disconnect, send_first))
        await asyncio.wait_for(started.wait(), timeout=1)
        done, _ = await asyncio.wait({disconnected}, timeout=1)
        assert disconnected in done
        await disconnected
        assert cancelled.is_set() and instances[0].closed

        request_sent = False
        events = []

        async def receive_second():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {'type': 'http.request', 'body': request_body, 'more_body': False}
            await asyncio.Event().wait()

        async def send_second(message):
            if message['type'] == 'http.response.body' and message.get('body'):
                events.append(json.loads(message['body']))

        await app(_execute_scope(task()), receive_second, send_second)
        assert events[-1]['type'] == 'final'  # The same key is no longer marked active.
        assert len(instances) == 2 and instances[1].closed
    asyncio.run(run())
