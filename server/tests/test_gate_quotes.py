import asyncio
import copy
import io
import json

import httpx
import pytest
from PIL import Image

from app.adapters import AdapterError, NaiAdapter, QUEUE_ERRORS, QUEUE_REQUEST_HEADER, QUEUE_TICKET_HEADER
from app.config import Settings
from app.gate_bridge import create_app
from test_gate_bridge import inpaint_images, quote_metadata, quote_result, task


def test_bridge_displays_gate_price_without_recalculating():
    calls = []
    async def gate(request):
        assert request.headers['authorization'] == 'Bearer quote-only'
        calls.append((request.method, request.url.path))
        assert request.url.path == '/v1/image/quote'
        assert request.method == 'POST'
        body = json.loads(request.content)
        assert body['operation'] == 'generate-image'
        if body['model'] == 'nai-diffusion-5-full':
            return httpx.Response(200, json={**quote_result(v5=.6), 'notes': ['自动切换 Medium']})
        return httpx.Response(200, json=quote_result(anlas=37))

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer quote-only'}
            response = await client.post('/api/quote', headers=headers, json=quote_metadata())
            assert response.status_code == 200
            assert response.json()['units'] == 37  # A local formula would classify this as free.
            assert response.json()['cost_limit'] == {'anlas': 37, 'v5': 0}
            response = await client.post('/api/quote', headers=headers, json=quote_metadata('nai-diffusion-5-full'))
            assert response.status_code == 200
            assert (response.json()['units'], response.json()['unit_label']) == (.6, 'V5单位')
            assert 'Medium' in response.json()['message']
        assert calls == [('POST', '/v1/image/quote'), ('POST', '/v1/image/quote')]
    asyncio.run(run())


@pytest.mark.parametrize('status', [400, 401, 402, 403, 409, 429, 500, 404])
def test_quote_errors_never_fall_back_to_a_local_price(status):
    async def gate(request):
        assert request.method == 'POST'
        return httpx.Response(status, json={'error': {'message': 'Gate quote rejected'}})

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer A'}, json=quote_metadata())
            assert response.status_code == (503 if status == 404 else 502 if status == 500 else status)
            assert 'units' not in response.json()
    asyncio.run(run())


@pytest.mark.parametrize('payload', [{}, {'source': 'gate', 'anlas': -1}, 'invalid'])
def test_invalid_gate_quote_never_becomes_free(payload):
    async def gate(request):
        assert request.method == 'POST'
        return httpx.Response(200, json=payload)
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer A'}, json=quote_metadata())
            assert response.status_code == 502
    asyncio.run(run())


def test_quote_maps_inpaint_model_and_preserves_pending_vibes_for_gate():
    sent = []
    async def gate(request):
        assert request.method == 'POST'
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=quote_result(anlas=7, encoding=4))

    async def run():
        item = quote_metadata('nai-diffusion-5-curated', mode='inpaint',
                              width=256, height=256, vibe_count=2, pending_vibe_encoding_count=2)
        original = copy.deepcopy(item)
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer A'}, json=item)
            assert response.status_code == 200, response.text
            assert (response.json()['units'], response.json()['encoding_units']) == (7, 4)
        assert item == original
        assert sent[0]['model'] == 'nai-diffusion-4-5-curated-inpainting'
        assert sent[0]['parameters']['mode'] == 'inpaint'
        assert sent[0]['parameters']['pending_vibe_encoding_count'] == 2
        assert sent[0]['parameters']['vibe_count'] == 2
    asyncio.run(run())


def test_max_quote_keeps_source_size_in_canonical_payload():
    sent = []
    async def gate(request):
        assert request.method == 'POST'
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=quote_result(anlas=45, output_size=[1467, 2144]))
    async def run():
        item = quote_metadata('nai-diffusion-5-full', mode='img2img', upscaled_enhance=True, strength=.5)
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer A'}, json=item)
            assert response.status_code == 200, response.text
            assert response.json()['output_size'] == [1467, 2144]
        p = sent[0]['parameters']
        assert (p['width'], p['height'], p['upscaled_enhance']) == (832, 1216, True)
    asyncio.run(run())


@pytest.mark.parametrize('extra', [
    {'image': 'eA=='}, {'mask': 'eA=='}, {'prompt': 'text'}, {'sampler': 'k_euler'},
    {'scale': 5}, {'width': {}}, {'sm': 1}, {'strength': float('nan')}, {'n_samples': 2},
])
def test_quote_rejects_nonpricing_fields_and_invalid_metadata(extra):
    async def gate(request):
        raise AssertionError('invalid metadata reached Gate')
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            query = quote_metadata(**extra)
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer fixture'},
                                        content=json.dumps(query))
            assert response.status_code == 422
    asyncio.run(run())


@pytest.mark.parametrize('query', [task(), {'operation': 'generate-image', 'payload': {}},
    {**quote_metadata(), 'prompt': 'not a price input'},
    {'operation': 'encode-vibe', 'model': 'nai-diffusion-4-5-full', 'parameters': {'image': 'eA=='}}])
def test_quote_requires_the_metadata_contract(query):
    async def gate(request):
        raise AssertionError('legacy quote payload reached Gate')
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer fixture'}, json=query)
            assert response.status_code == 422
    asyncio.run(run())


@pytest.mark.parametrize('operation,parameters', [('upscale', {'width': 1024, 'height': 1024}),
    ('augment-image', {'width': 1024, 'height': 1024, 'req_type': 'bg-removal'}), ('encode-vibe', {})])
def test_tool_quotes_relay_metadata_without_images(operation, parameters):
    sent = []
    async def gate(request):
        assert request.method == 'POST'
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=quote_result(anlas=2))
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            query = {'operation': operation, 'model': 'nai-diffusion-4-5-full', 'parameters': parameters}
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer fixture'}, json=query)
            assert response.status_code == 200
            expected_model = 'nai-diffusion-5-curated' if operation == 'upscale' else query['model']
            assert sent == [{**query, 'model': expected_model}]
    asyncio.run(run())


@pytest.mark.parametrize('gate_mode', [True, False])
def test_adapter_sends_cost_ceiling_only_to_gate(gate_mode):
    output = io.BytesIO()
    Image.new('RGB', (64, 64), 'navy').save(output, format='PNG')
    sent = []
    async def upstream(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, content=output.getvalue(), headers={'content-type': 'image/png'})
    async def run():
        adapter = NaiAdapter(Settings(nai_base_url='http://fixture', nai_token='fixture'), gate_mode=gate_mode)
        await adapter.client.aclose()
        adapter.client = httpx.AsyncClient(base_url='http://fixture', transport=httpx.MockTransport(upstream))
        item = task()
        item['cost_limit'] = {'anlas': 7, 'v5': 0}
        item['parameters']['vibe_encoding_cost_limit'] = {'anlas': 2, 'v5': 0}
        try:
            await adapter.execute(item)
        finally:
            await adapter.close()
        assert ('cost_limit' in sent[0]) is gate_mode
        if gate_mode:
            assert sent[0]['cost_limit'] == item['cost_limit']
        assert 'vibe_encoding_cost_limit' not in sent[0]['parameters']
    asyncio.run(run())


@pytest.mark.parametrize('gate_mode', [True, False])
@pytest.mark.parametrize('operation,stream', [('generate', False), ('generate', True), ('img2img', False),
    ('inpaint', False), ('upscale', False), ('augment', False), ('encode_vibe', False)])
def test_adapter_forwards_queue_headers_only_to_gate(gate_mode, operation, stream):
    image, mask = inpaint_images((64, 64))
    queue = {'ticket_id': '11111111-1111-4111-8111-111111111111',
             'request_id': '22222222-2222-4222-8222-222222222222', 'submitted': False}
    sent = []
    async def upstream(request):
        sent.append(request)
        if operation == 'encode_vibe':
            return httpx.Response(200, json={'encoding': 'ZW5jb2RlZA=='})
        if stream:
            return httpx.Response(200, text='event: final\ndata: ' + json.dumps({'image': image}) + '\n\n',
                                  headers={'content-type': 'text/event-stream'})
        import base64
        return httpx.Response(200, content=base64.b64decode(image), headers={'content-type': 'image/png'})
    async def run():
        adapter = NaiAdapter(Settings(nai_base_url='http://fixture', nai_token='fixture'), gate_mode=gate_mode)
        await adapter.client.aclose()
        adapter.client = httpx.AsyncClient(base_url='http://fixture', transport=httpx.MockTransport(upstream))
        item = task()
        item.update(operation=operation, _gate_queue=queue)
        item['parameters'].update(width=64, height=64, stream=stream)
        if operation != 'generate':
            item['parameters']['image'] = image
        if operation == 'inpaint':
            item['parameters']['mask'] = mask
        if operation == 'augment':
            item['parameters']['req_type'] = 'lineart'
        try:
            await adapter.execute(item)
        finally:
            await adapter.close()
        assert len(sent) == 1
        for header, key in ((QUEUE_TICKET_HEADER, 'ticket_id'), (QUEUE_REQUEST_HEADER, 'request_id')):
            assert sent[0].headers.get(header) == (queue[key] if gate_mode else None)
        payload = json.loads(sent[0].content)
        assert not {'_gate_queue', 'ticket_id', 'request_id'}.intersection(payload)
        assert not {'_gate_queue', 'ticket_id', 'request_id'}.intersection(payload.get('parameters', {}))
        assert queue['submitted'] is gate_mode
    asyncio.run(run())


@pytest.mark.parametrize('code', list(QUEUE_ERRORS))
def test_adapter_preserves_known_queue_errors_without_echoing_body(code):
    status = QUEUE_ERRORS[code][0]
    async def upstream(request):
        return httpx.Response(status, json={'error': {'code': code, 'message': 'private input must not be echoed'}})
    async def run():
        adapter = NaiAdapter(Settings(nai_base_url='http://fixture', nai_token='fixture'), gate_mode=True)
        await adapter.client.aclose()
        adapter.client = httpx.AsyncClient(base_url='http://fixture', transport=httpx.MockTransport(upstream))
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute(task())
            error = caught.value
            assert error.code == code and 'private input' not in error.message
            if code in {'queue_ticket_active', 'queue_ticket_used'}:
                assert error.uncertain and not error.retryable
        finally:
            await adapter.close()
    asyncio.run(run())


@pytest.mark.parametrize('failure', [httpx.ConnectError, httpx.ConnectTimeout])
def test_adapter_failed_connection_leaves_ticket_available_for_cleanup(failure):
    queue = {'ticket_id': '11111111-1111-4111-8111-111111111111',
             'request_id': '22222222-2222-4222-8222-222222222222', 'submitted': False}
    async def upstream(request):
        raise failure('offline connection failure', request=request)
    async def run():
        adapter = NaiAdapter(Settings(nai_base_url='http://fixture', nai_token='fixture'), gate_mode=True)
        await adapter.client.aclose()
        adapter.client = httpx.AsyncClient(base_url='http://fixture', transport=httpx.MockTransport(upstream))
        try:
            with pytest.raises(AdapterError) as caught:
                await adapter.execute({**task(), '_gate_queue': queue})
            assert not caught.value.uncertain and not queue['submitted']
        finally:
            await adapter.close()
    asyncio.run(run())
