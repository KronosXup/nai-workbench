import asyncio
import json
import uuid

import httpx
import pytest

from app.adapters import Artifact
from app.gate_bridge import create_app
import app.gate_bridge as gate_bridge
from test_gate_bridge import quote_metadata, quote_result


def quote_task():
    return {
        'request_id': str(uuid.uuid4()),
        'operation': 'generate',
        'model': 'nai-diffusion-4-5-full',
        'prompt': 'offline fixture',
        'negative_prompt': '',
        'label': 'test',
        'parameters': {
            'width': 832, 'height': 1216, 'steps': 28, 'scale': 5,
            'seed': 1, 'n_samples': 1,
        },
    }


def identity_response(request, calls):
    if request.url.path == '/v1/image/quote' and request.method == 'POST':
        return httpx.Response(200, json=quote_result())
    token = request.headers.get('authorization')
    if request.url.path == '/user/information':
        calls.append((request.url.path, token))
        if token in {'Bearer A', 'Bearer B', 'Bearer valid'}:
            return httpx.Response(200, json={'username': token[7:]})
        return httpx.Response(401)
    if request.url.path == '/user/subscription':
        calls.append((request.url.path, token))
        return httpx.Response(200, json={'naiGate': {
            'anlasMonthlyLimit': 100, 'anlasLeft': 80, 'v5LeftToday': 10,
            'v5DailyLimit': 10, 'v5Unlimited': False, 'imageModelScope': 'all',
        }})
    if request.url.path == '/v1/me':
        return httpx.Response(404)
    raise AssertionError(f'unexpected Gate request: {request.url.path}')


def test_quote_authenticates_only_with_final_gate_post(monkeypatch):
    calls = []
    def parse_must_not_run(*args, **kwargs):
        raise AssertionError('quote metadata reached image-task validation')
    monkeypatch.setattr(gate_bridge, 'validate_task', parse_must_not_run)
    async def gate(request):
        calls.append((request.method, request.url.path))
        assert json.loads(request.content) == quote_metadata()
        return httpx.Response(401, json={'error': {'message': 'invalid key'}})
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer fake'}, json=quote_metadata())
            assert response.status_code == 401
            assert response.headers['content-security-policy'] == "frame-ancestors 'none'"
            assert response.headers['x-frame-options'] == 'DENY'
            assert calls == [('POST', '/v1/image/quote')]
    asyncio.run(run())


def test_execute_rejects_repeated_bad_key_without_repeated_gate_lookups():
    calls = []

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, calls)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            for _ in range(3):
                response = await client.post('/api/execute', headers={'Authorization': 'Bearer fake'}, json=quote_task())
                assert response.status_code == 401
            assert calls == [('/user/information', 'Bearer fake')]

    asyncio.run(run())


def test_execute_identity_admission_is_retryable_before_generation(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW', 1)
    submitted = []

    class Adapter:
        def __init__(self, settings, *, gate_mode):
            pass

        async def execute(self, item, on_preview):
            submitted.append(item)
            return [Artifact(b'offline fixture')]

        async def close(self):
            pass

    def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        assert request.url.path == '/user/information'
        return httpx.Response(200, json={'username': 'fixture'})

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            first = await client.post('/api/execute', headers={'Authorization': 'Bearer A'}, json=quote_task())
            assert first.status_code == 200
            second = await client.post('/api/execute', headers={'Authorization': 'Bearer B'}, json=quote_task())
            assert second.status_code == 429
            assert second.json()['code'] == 'gate_busy' and second.json()['retryable']
            assert second.json()['retry_after'] == 60 and not second.json()['uncertain']
            assert len(submitted) == 1

    asyncio.run(run())


def test_queue_status_needs_a_valid_key_even_when_snapshot_is_cached():
    calls = []

    def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            if request.headers.get('authorization') == 'Bearer valid':
                return httpx.Response(200, json={'username': 'fixture'})
            return httpx.Response(401)
        if request.url.path == '/queue-status':
            return httpx.Response(200, json={'global': {'active': 1, 'waiting': 0, 'concurrency': 8},
                                              'image_cooldown_remaining': 0})
        raise AssertionError(request.url.path)

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            assert (await client.get('/api/queue-status', headers={'Authorization': 'Bearer valid'})).status_code == 200
            assert (await client.get('/api/queue-status', headers={'Authorization': 'Bearer fake'})).status_code == 401
            assert calls == ['/user/information', '/queue-status', '/user/information']

    asyncio.run(run())


def test_execute_body_timeout_releases_slot_and_does_not_submit(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'REQUEST_READ_TIMEOUT_SECONDS', 0.02)
    monkeypatch.setattr(gate_bridge, 'EXECUTE_PREP_MAX_CONCURRENCY', 1)
    submitted = []

    class Adapter:
        def __init__(self, settings, *, gate_mode):
            pass

        async def execute(self, item, on_preview):
            submitted.append(item)
            return [Artifact(b'offline fixture')]

        async def close(self):
            pass

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, [])), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            entered = asyncio.Event()
            raw = json.dumps(quote_task()).encode()

            async def stalled_body():
                yield raw[:8]
                entered.set()
                await asyncio.sleep(0.08)
                yield raw[8:]

            pending = asyncio.create_task(client.post('/api/execute', headers=headers, content=stalled_body(), timeout=None))
            await asyncio.wait_for(entered.wait(), 2)
            busy = await client.post('/api/execute', headers=headers, json=quote_task())
            assert busy.status_code == 429 and busy.json()['code'] == 'gate_busy'
            assert busy.json()['retryable'] and not busy.json()['uncertain']
            assert (await pending).status_code == 408
            assert not submitted
            assert (await client.post('/api/execute', headers=headers, json=quote_task())).status_code == 200
            assert len(submitted) == 1

    asyncio.run(run())


def test_tag_body_timeout_releases_slot_without_calling_tag_service(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'REQUEST_READ_TIMEOUT_SECONDS', 0.02)
    monkeypatch.setattr(gate_bridge, 'TAG_MAX_CONCURRENCY', 1)
    calls = []

    def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'fixture'})
        if request.url.path == '/ai/generate-image/suggest-tags':
            return httpx.Response(200, json={'tags': []})
        raise AssertionError(request.url.path)

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            entered = asyncio.Event()
            raw = json.dumps({'prompt': 'blue', 'model': 'nai-diffusion-5-full'}).encode()

            async def stalled_body():
                yield raw[:8]
                entered.set()
                await asyncio.sleep(0.08)
                yield raw[8:]

            pending = asyncio.create_task(client.post('/api/suggest-tags', headers=headers, content=stalled_body(), timeout=None))
            await asyncio.wait_for(entered.wait(), 2)
            assert (await client.post('/api/suggest-tags', headers=headers,
                json={'prompt': 'blue', 'model': 'nai-diffusion-5-full'})).status_code == 429
            assert (await pending).status_code == 408
            assert calls == ['/user/information']
            assert (await client.post('/api/suggest-tags', headers=headers,
                json={'prompt': 'blue', 'model': 'nai-diffusion-5-full'})).status_code == 200
            assert calls == ['/user/information', '/ai/generate-image/suggest-tags']

    asyncio.run(run())


@pytest.mark.parametrize('value', ['false', 0, 1, None, []])
def test_nonboolean_stream_parameter_is_rejected_before_execute(value):
    async def run():
        calls = []
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, calls)))
        item = quote_task()
        item['parameters']['stream'] = value
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            assert (await client.post('/api/execute', headers=headers, json=item)).status_code == 422
            assert calls == [('/user/information', 'Bearer valid')]

    asyncio.run(run())


def test_gate_identity_cache_is_key_scoped_shared_with_me_and_expires(monkeypatch):
    now = [100.0]
    calls = []
    monkeypatch.setattr(gate_bridge, '_security_now', lambda: now[0])
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            assert gate_mode is True
        async def execute(self, item, on_preview):
            return [Artifact(b'offline fixture')]
        async def close(self):
            pass
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, calls)), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers_a = {'Authorization': 'Bearer A'}
            headers_b = {'Authorization': 'Bearer B'}
            me = await client.get('/api/me', headers=headers_a)
            assert me.status_code == 200 and me.json()['name'] == 'A'
            for _ in range(2):
                assert (await client.post('/api/execute', headers=headers_a, json=quote_task())).status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == ['Bearer A']
            assert (await client.post('/api/execute', headers=headers_b, json=quote_task())).status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == ['Bearer A', 'Bearer B']
            now[0] += gate_bridge.GATE_IDENTITY_CACHE_TTL_SECONDS + 1
            assert (await client.post('/api/execute', headers=headers_a, json=quote_task())).status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == ['Bearer A', 'Bearer B', 'Bearer A']
            assert [token for path, token in calls if path == '/user/subscription'] == ['Bearer A']
    asyncio.run(run())


def test_execute_identity_lookup_is_single_flight():
    calls = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            entered.set()
            await release.wait()
            return httpx.Response(200, json={'username': 'fixture'})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            first = asyncio.create_task(client.post('/api/execute', headers=headers, json={}))
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(client.post('/api/execute', headers=headers, json={}))
            await asyncio.sleep(0)
            release.set()
            first_response, second_response = await asyncio.gather(first, second)
            assert first_response.status_code == second_response.status_code == 422
            assert calls == ['/user/information']

    asyncio.run(run())


def test_identity_cache_entry_count_is_bounded(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_CACHE_MAX_ENTRIES', 2)
    calls = []

    async def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        if request.url.path == '/user/information':
            calls.append(request.headers['authorization'])
            return httpx.Response(200, json={'username': request.headers['authorization'][7:]})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            for token in ('A', 'B', 'C', 'A'):
                response = await client.post('/api/execute', headers={'Authorization': f'Bearer {token}'},
                    json={})
                assert response.status_code == 422
            assert calls == ['Bearer A', 'Bearer B', 'Bearer C', 'Bearer A']

    asyncio.run(run())


def test_gate_identity_cache_misses_have_a_global_rate_limit(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW', 1)
    calls = []

    async def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        calls.append(request.headers.get('authorization'))
        return httpx.Response(401)

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            first = await client.post('/api/execute', headers={'Authorization': 'Bearer fake-one'}, json={})
            second = await client.post('/api/execute', headers={'Authorization': 'Bearer fake-two'}, json={})
            assert first.status_code == 401
            assert second.status_code == 429
            assert calls == ['Bearer fake-one']

    asyncio.run(run())


def test_gate_identity_lookup_concurrency_is_bounded(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_LOOKUP_MAX_CONCURRENCY', 1)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            return httpx.Response(200, json=quote_result())
        token = request.headers.get('authorization')
        calls.append((request.url.path, token))
        if request.url.path == '/user/information':
            entered.set()
            await release.wait()
            return httpx.Response(200, json={'username': token[7:]})
        if request.url.path == '/user/subscription':
            return httpx.Response(200, json={'naiGate': {
                'anlasMonthlyLimit': 100, 'anlasLeft': 80, 'v5LeftToday': 10,
                'v5DailyLimit': 10, 'v5Unlimited': False, 'imageModelScope': 'all',
            }})
        if request.url.path == '/v1/me':
            return httpx.Response(404)
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            first = asyncio.create_task(client.get('/api/me', headers={'Authorization': 'Bearer A'}))
            await asyncio.wait_for(entered.wait(), 2)
            rejected = await client.get('/api/me', headers={'Authorization': 'Bearer B'})
            assert rejected.status_code == 503
            release.set()
            assert (await first).status_code == 200
            assert [path for path, _ in calls if path == '/user/information'] == ['/user/information']

    asyncio.run(run())


def test_metadata_quotes_do_not_wait_for_image_or_identity_slots():
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def gate(request):
        assert request.method == 'POST' and request.url.path == '/v1/image/quote'
        calls.append(request)
        if len(calls) == 3:
            entered.set()
        await release.wait()
        return httpx.Response(200, json=quote_result())
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            pending = [asyncio.create_task(client.post('/api/quote', headers={'Authorization': 'Bearer valid'},
                        json=quote_metadata())) for _ in range(3)]
            try:
                await asyncio.wait_for(entered.wait(), 2)
            finally:
                release.set()
            assert all(response.status_code == 200 for response in await asyncio.gather(*pending))
    asyncio.run(run())


def test_quote_metadata_body_cap_and_timeout(monkeypatch):
    calls = []
    monkeypatch.setattr(gate_bridge, 'QUOTE_READ_TIMEOUT_SECONDS', 0.02)
    async def gate(request):
        calls.append((request.method, request.url.path))
        return httpx.Response(200, json=quote_result())
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer A'}
            response = await client.post('/api/quote', headers=headers, content=b'x' * 4097)
            assert response.status_code == 413 and calls == []
            async def oversized_body():
                yield b'x' * 2048
                yield b'x' * 2049
            response = await client.post('/api/quote', headers=headers, content=oversized_body())
            assert response.status_code == 413 and calls == []
            raw = json.dumps(quote_metadata()).encode()
            async def stalled_body():
                yield raw[:8]
                await asyncio.sleep(0.08)
                yield raw[8:]
            response = await client.post('/api/quote', headers=headers, content=stalled_body())
            assert response.status_code == 408 and calls == []
            assert (await client.post('/api/quote', headers=headers, json=quote_metadata())).status_code == 200
            assert calls == [('POST', '/v1/image/quote')]
    asyncio.run(run())


def test_quote_frequency_limits_do_not_let_other_keys_block_valid_quotes(monkeypatch):
    now = [300.0]
    calls = []
    monkeypatch.setattr(gate_bridge, '_security_now', lambda: now[0])
    monkeypatch.setattr(gate_bridge, 'QUOTE_KEY_RATE_PER_WINDOW', 2)

    async def gate(request):
        if request.url.path == '/v1/image/quote' and request.method == 'POST':
            if request.headers['authorization'].startswith('Bearer invalid-'):
                return httpx.Response(401, json={'error': {'message': 'Invalid Key'}})
            return httpx.Response(200, json=quote_result())
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': request.headers['authorization'][7:]})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            a = {'Authorization': 'Bearer A'}
            b = {'Authorization': 'Bearer B'}
            assert (await client.post('/api/quote', headers=a, json=quote_metadata())).status_code == 200
            assert (await client.post('/api/quote', headers=a, json=quote_metadata())).status_code == 200
            assert (await client.post('/api/quote', headers=a, json=quote_metadata())).status_code == 429
            # Neither a busy Key nor invalid credentials consume another Key's allowance.
            assert (await client.post('/api/quote', headers=b, json=quote_metadata())).status_code == 200
            for index in range(3):
                invalid = {'Authorization': f'Bearer invalid-{index}'}
                assert (await client.post('/api/quote', headers=invalid, json=quote_metadata())).status_code == 401
            assert (await client.post('/api/quote', headers=b, json=quote_metadata())).status_code == 200
            assert (await client.post('/api/quote', headers=b, json=quote_metadata())).status_code == 429

            now[0] += gate_bridge.QUOTE_RATE_WINDOW_SECONDS + 1
            assert (await client.post('/api/quote', headers=b, json=quote_metadata())).status_code == 200

    asyncio.run(run())


def test_quote_uses_small_metadata_input_ceiling():
    assert gate_bridge.QUOTE_MAX_BODY_BYTES == 4 * 1024
