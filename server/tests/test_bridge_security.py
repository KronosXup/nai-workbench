import asyncio
import base64
import json
import uuid

import httpx
import pytest

from app.adapters import Artifact
from app.gate_bridge import create_app
import app.gate_bridge as gate_bridge


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
    raise AssertionError(f'unexpected Gate request: {request.url.path}')


def test_quote_rejects_fake_bearer_before_parsing_large_image(monkeypatch):
    calls = []

    def parse_must_not_run(*args, **kwargs):
        raise AssertionError('unverified quote body reached validation')

    monkeypatch.setattr(gate_bridge, 'validate_task', parse_must_not_run)

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, calls)))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            body = quote_task()
            body['parameters']['image'] = 'A' * (512 * 1024)
            response = await client.post('/api/quote', headers={'Authorization': 'Bearer fake'}, json=body)
            assert response.status_code == 401
            assert response.headers['content-security-policy'] == "frame-ancestors 'none'"
            assert response.headers['x-frame-options'] == 'DENY'
            assert calls == [('/user/information', 'Bearer fake')]

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
def test_nonboolean_stream_parameter_is_rejected_before_quote_or_execute(value):
    async def run():
        calls = []
        app = create_app('http://gate.fixture', httpx.MockTransport(lambda request: identity_response(request, calls)))
        item = quote_task()
        item['parameters']['stream'] = value
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            assert (await client.post('/api/quote', headers=headers, json=item)).status_code == 422
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
            assert (await client.post('/api/quote', headers=headers_a, json=quote_task())).status_code == 200
            assert (await client.post('/api/quote', headers=headers_a, json=quote_task())).status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == ['Bearer A']

            # Keep a large, valid reference payload within the existing 25 MiB
            # contract and verify it still reaches the estimate path.
            large_reference = base64.b64encode(b'x' * 750_000).decode()
            reference_task = quote_task()
            reference_task['parameters'].update(
                reference_image_multiple=[large_reference],
                reference_strength_multiple=[0.5],
                reference_information_extracted_multiple=[0.5],
            )
            reference_quote = await client.post('/api/quote', headers=headers_a, json=reference_task)
            assert reference_quote.status_code == 200
            assert calls.count(('/user/subscription', 'Bearer A')) == 1

            other = await client.post('/api/quote', headers=headers_b, json=quote_task())
            assert other.status_code == 200
            assert ('/user/subscription', 'Bearer B') not in calls
            assert [token for path, token in calls if path == '/user/information'] == ['Bearer A', 'Bearer B']

            now[0] += gate_bridge.GATE_IDENTITY_CACHE_TTL_SECONDS + 1
            refreshed = await client.post('/api/quote', headers=headers_a, json=quote_task())
            assert refreshed.status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == [
                'Bearer A', 'Bearer B', 'Bearer A',
            ]

            # Execute reuses a recent identity check. Gate still checks the Key
            # on the actual image request, including after revocation.
            executed = await client.post('/api/execute', headers=headers_a, json=quote_task())
            assert executed.status_code == 200
            assert [token for path, token in calls if path == '/user/information'] == [
                'Bearer A', 'Bearer B', 'Bearer A',
            ]
            assert [token for path, token in calls if path == '/user/subscription'] == ['Bearer A']

    asyncio.run(run())


def test_quote_identity_lookup_is_single_flight():
    calls = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gate(request):
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
            first = asyncio.create_task(client.post('/api/quote', headers=headers, json=quote_task()))
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(client.post('/api/quote', headers=headers, json=quote_task()))
            await asyncio.sleep(0)
            release.set()
            first_response, second_response = await asyncio.gather(first, second)
            assert first_response.status_code == second_response.status_code == 200
            assert calls == ['/user/information']

    asyncio.run(run())


def test_identity_cache_entry_count_is_bounded(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_CACHE_MAX_ENTRIES', 2)
    calls = []

    async def gate(request):
        if request.url.path == '/user/information':
            calls.append(request.headers['authorization'])
            return httpx.Response(200, json={'username': request.headers['authorization'][7:]})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            for token in ('A', 'B', 'C', 'A'):
                response = await client.post('/api/quote', headers={'Authorization': f'Bearer {token}'},
                    json=quote_task())
                assert response.status_code == 200
            assert calls == ['Bearer A', 'Bearer B', 'Bearer C', 'Bearer A']

    asyncio.run(run())


def test_gate_identity_cache_misses_have_a_global_rate_limit(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'GATE_IDENTITY_LOOKUP_RATE_PER_WINDOW', 1)
    calls = []

    async def gate(request):
        calls.append(request.headers.get('authorization'))
        return httpx.Response(401)

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            first = await client.post('/api/quote', headers={'Authorization': 'Bearer fake-one'}, json=quote_task())
            second = await client.post('/api/quote', headers={'Authorization': 'Bearer fake-two'}, json=quote_task())
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


def test_quote_slot_is_bounded_and_released_when_client_cancels(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'QUOTE_MAX_CONCURRENCY', 1)

    async def gate(request):
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'fixture'})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers = {'Authorization': 'Bearer valid'}
            body_started = asyncio.Event()
            continue_body = asyncio.Event()
            raw = json.dumps(quote_task()).encode()

            async def slow_body():
                yield raw[:8]
                body_started.set()
                await continue_body.wait()
                yield raw[8:]

            pending = asyncio.create_task(client.post('/api/quote', headers=headers,
                content=slow_body(), timeout=None))
            await asyncio.wait_for(body_started.wait(), 2)
            rejected = await client.post('/api/quote', headers=headers, json=quote_task())
            assert rejected.status_code == 429
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            continue_body.set()
            after_cancel = await client.post('/api/quote', headers=headers, json=quote_task())
            assert after_cancel.status_code == 200

    asyncio.run(run())


def test_quote_body_cap_timeout_rate_limits_and_slots_are_bounded(monkeypatch):
    calls = []
    now = [200.0]
    monkeypatch.setattr(gate_bridge, '_security_now', lambda: now[0])
    monkeypatch.setattr(gate_bridge, 'QUOTE_MAX_BODY_BYTES', 64)
    monkeypatch.setattr(gate_bridge, 'QUOTE_READ_TIMEOUT_SECONDS', 0.02)
    monkeypatch.setattr(gate_bridge, 'QUOTE_MAX_CONCURRENCY', 1)
    original_validator = gate_bridge.validate_task

    async def gate(request):
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': request.headers['authorization'][7:]})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            headers_a = {'Authorization': 'Bearer A'}
            headers_b = {'Authorization': 'Bearer B'}

            # Exercise the size guard with a test-only cap; validation is
            # patched to prove rejection happens before parsing.
            parse_calls = []
            monkeypatch.setattr(gate_bridge, 'validate_task', lambda *args, **kwargs: parse_calls.append(True))
            response = await client.post('/api/quote', headers=headers_a, content=b'x' * 65)
            assert response.status_code == 413 and parse_calls == []

            # A stalled request times out and releases its quote slot.
            monkeypatch.setattr(gate_bridge, 'QUOTE_MAX_BODY_BYTES', 4096)
            raw = json.dumps(quote_task()).encode()
            started = asyncio.Event()

            async def stalled_body():
                yield raw[:8]
                started.set()
                await asyncio.sleep(0.08)
                yield raw[8:]

            timed_out = await client.post('/api/quote', headers=headers_a,
                content=stalled_body(), timeout=None)
            assert timed_out.status_code == 408 and started.is_set()

            # Prove timeout/cap failures did not leak the quote slot.
            monkeypatch.setattr(gate_bridge, 'validate_task', original_validator)
            first = await client.post('/api/quote', headers=headers_a, json=quote_task())
            assert first.status_code == 200
            assert calls.count('/user/information') == 1

    asyncio.run(run())


def test_quote_frequency_limits_are_bounded_per_key_and_globally(monkeypatch):
    now = [300.0]
    calls = []
    monkeypatch.setattr(gate_bridge, '_security_now', lambda: now[0])
    monkeypatch.setattr(gate_bridge, 'QUOTE_GLOBAL_RATE_PER_WINDOW', 3)
    monkeypatch.setattr(gate_bridge, 'QUOTE_KEY_RATE_PER_WINDOW', 2)

    async def gate(request):
        calls.append(request.url.path)
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': request.headers['authorization'][7:]})
        raise AssertionError(f'unexpected Gate request: {request.url.path}')

    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://workbench') as client:
            a = {'Authorization': 'Bearer A'}
            b = {'Authorization': 'Bearer B'}
            assert (await client.post('/api/quote', headers=a, json=quote_task())).status_code == 200
            assert (await client.post('/api/quote', headers=a, json=quote_task())).status_code == 200
            assert (await client.post('/api/quote', headers=a, json=quote_task())).status_code == 429
            # A's per-Key limit does not consume the process-wide slot for B.
            assert (await client.post('/api/quote', headers=b, json=quote_task())).status_code == 200
            assert (await client.post('/api/quote', headers=b, json=quote_task())).status_code == 429

            now[0] += gate_bridge.QUOTE_RATE_WINDOW_SECONDS + 1
            assert (await client.post('/api/quote', headers=b, json=quote_task())).status_code == 200

    asyncio.run(run())


def test_quote_uses_existing_25_mib_input_ceiling():
    assert gate_bridge.QUOTE_MAX_BODY_BYTES == 25 * 1024 * 1024
