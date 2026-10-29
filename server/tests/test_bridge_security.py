import asyncio
import json
import uuid

import httpx
import pytest

from app.adapters import Artifact, AdapterError, QUEUE_REQUEST_HEADER, QUEUE_TICKET_HEADER
from app.gate_bridge import create_app
import app.gate_bridge as gate_bridge
from test_gate_bridge import inpaint_images, quote_metadata, quote_result


def ticket_snapshot(*, operation='generate-image', state='ready'):
    return dict(ticket_id=str(uuid.uuid4()), request_id=str(uuid.uuid4()), operation=operation,
                state=state, position=1 if state == 'queued' else 0, expires_in=120, poll_after=3)


def ticket_headers(ticket, token='valid'):
    return {'Authorization': 'Bearer ' + token, QUEUE_TICKET_HEADER: ticket['ticket_id'],
            QUEUE_REQUEST_HEADER: ticket['request_id']}


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


@pytest.mark.parametrize('requires_anlas', [None, False, True])
def test_image_queue_proxy_preserves_key_ownership_and_ticket_lifecycle(requires_anlas):
    tickets, calls = {}, []
    extra = {} if requires_anlas is None else {'requires_anlas': requires_anlas}
    async def gate(request):
        token, path = request.headers['authorization'], request.url.path
        calls.append((request.method, path, token))
        assert path.startswith('/v1/image/queue')
        if path == '/v1/image/queue':
            query = json.loads(request.content)
            assert set(query) == {'request_id', 'operation'} | set(extra)
            assert query.get('requires_anlas') == requires_anlas
            ticket = {**ticket_snapshot(operation=query['operation'], state='queued'), 'request_id': query['request_id']}
            tickets[ticket['ticket_id']] = (token, ticket)
            return httpx.Response(201, json=ticket)
        ticket_id = path.split('/')[4]
        if ticket_id not in tickets or tickets[ticket_id][0] != token:
            return httpx.Response(404, json={'error': {'code': 'queue_ticket_not_found', 'message': 'hidden'}})
        ticket = tickets[ticket_id][1]
        if request.method == 'DELETE':
            ticket.update(state='cancelled', position=0, expires_in=0)
        return httpx.Response(200, json=ticket)
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            a, b = {'Authorization': 'Bearer A'}, {'Authorization': 'Bearer B'}
            created = await client.post('/api/image-queue', headers=a,
                json={'request_id': str(uuid.uuid4()), 'operation': 'generate-image', **extra})
            assert created.status_code == 201
            ticket = created.json()
            path = '/api/image-queue/' + ticket['ticket_id']
            assert (await client.get(path, headers=a)).json() == ticket
            assert (await client.post(path + '/heartbeat', headers=a)).json() == ticket
            for method in ('GET', 'DELETE'):
                denied = await client.request(method, path, headers=b)
                assert denied.status_code == 404 and denied.json()['code'] == 'queue_ticket_not_found'
                assert isinstance(denied.json()['detail'], str) and 'hidden' not in denied.json()['detail']
            cancelled = await client.delete(path, headers=a)
            assert cancelled.json()['state'] == 'cancelled'
            assert all('/user/' not in path for _, path, _ in calls)
    asyncio.run(run())


@pytest.mark.parametrize('state,code,status', [('queued', 'queue_ticket_not_ready', 409),
    ('active', 'queue_ticket_used', 409), ('finished', 'queue_ticket_used', 409),
    ('expired', 'queue_ticket_expired', 410), ('cancelled', 'queue_ticket_cancelled', 409)])
def test_ticketed_execute_checks_state_before_reading_upload(state, code, status):
    ticket = ticket_snapshot(state=state)
    async def gate(request):
        assert request.method == 'GET' and request.url.path.endswith(ticket['ticket_id'])
        return httpx.Response(200, json=ticket)
    async def run():
        body_read = []
        async def body():
            body_read.append(True)
            yield b'{}'
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/execute', headers=ticket_headers(ticket), content=body())
            assert response.status_code == status and response.json()['code'] == code
            assert body_read == []
            assert response.json()['uncertain'] is (state in {'active', 'finished'})
    asyncio.run(run())


@pytest.mark.parametrize('headers', [{QUEUE_TICKET_HEADER: str(uuid.uuid4())},
    {QUEUE_REQUEST_HEADER: str(uuid.uuid4())}, {QUEUE_TICKET_HEADER: 'invalid', QUEUE_REQUEST_HEADER: 'invalid'}])
def test_ticketed_execute_rejects_incomplete_headers_before_reading(headers):
    async def gate(request):
        raise AssertionError('invalid ticket headers reached Gate')
    async def run():
        async def body():
            raise AssertionError('invalid ticket headers read an upload')
            yield b''
        app = create_app('http://gate.fixture', httpx.MockTransport(gate))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/execute', headers={'Authorization': 'Bearer valid', **headers}, content=body())
            assert response.status_code == 400 and response.json()['code'] == 'queue_invalid_request'
    asyncio.run(run())


@pytest.mark.parametrize('operation,queue_operation', [('generate', 'generate-image'), ('img2img', 'generate-image'),
    ('inpaint', 'generate-image'), ('upscale', 'upscale'), ('augment', 'augment-image'), ('encode_vibe', 'encode-vibe')])
def test_ticketed_execute_passes_internal_ticket_for_every_image_operation(operation, queue_operation):
    ticket = ticket_snapshot(operation=queue_operation)
    sent, calls = [], []
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            assert gate_mode
        async def execute(self, task, on_preview):
            sent.append(task)
            task['_gate_queue']['submitted'] = True
            return [Artifact(b'fixture')]
        async def close(self):
            pass
    async def gate(request):
        calls.append(request.method)
        assert request.method == 'GET'
        return httpx.Response(200, json=ticket)
    async def run():
        item = quote_task()
        image, mask = inpaint_images((64, 64))
        item['operation'] = operation
        item['parameters'].update(width=64, height=64)
        if operation != 'generate':
            item['parameters']['image'] = image
        if operation == 'inpaint':
            item['parameters']['mask'] = mask
        if operation == 'augment':
            item['parameters']['req_type'] = 'lineart'
        app = create_app('http://gate.fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/execute', headers=ticket_headers(ticket), json=item)
            assert response.status_code == 200 and response.json()['type'] == 'final'
            assert sent[0]['request_id'] != ticket['request_id']
            assert sent[0]['_gate_queue']['ticket_id'] == ticket['ticket_id']
            assert '_gate_queue' not in sent[0]['parameters']
            assert calls == ['GET']
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['body', 'operation', 'prepare', 'cancel-upload'])
def test_ticketed_execute_cancels_ready_ticket_after_local_failure(failure):
    ticket = ticket_snapshot(operation='upscale' if failure == 'operation' else 'generate-image')
    calls = []
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            pass
        async def execute(self, task, on_preview):
            raise AdapterError('invalid_image', '本地图片无效')
        async def close(self):
            pass
    async def gate(request):
        calls.append(request.method)
        return httpx.Response(200, json={**ticket, 'state': 'cancelled' if request.method == 'DELETE' else 'ready'})
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            if failure == 'cancel-upload':
                entered = asyncio.Event()
                async def body():
                    entered.set()
                    await asyncio.Event().wait()
                    yield b'{}'
                pending = asyncio.create_task(client.post('/api/execute', headers=ticket_headers(ticket), content=body()))
                await asyncio.wait_for(entered.wait(), 2)
                pending.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await pending
            else:
                response = await client.post('/api/execute', headers=ticket_headers(ticket), json={} if failure == 'body' else quote_task())
                assert response.status_code == {'body': 422, 'operation': 409, 'prepare': 200}[failure]
            assert calls == ['GET', 'DELETE']
    asyncio.run(run())


def test_ticketed_upload_waits_for_local_preparation_and_cleans_up_cancellation(monkeypatch):
    monkeypatch.setattr(gate_bridge, 'EXECUTE_PREP_MAX_CONCURRENCY', 1)
    tickets = [ticket_snapshot() for _ in range(3)]
    deleted = []
    second_validated = asyncio.Event()
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            pass
        async def execute(self, task, on_preview):
            task['_gate_queue']['submitted'] = True
            return [Artifact(b'fixture')]
        async def close(self):
            pass
    async def gate(request):
        ticket = next(ticket for ticket in tickets if request.url.path.endswith(ticket['ticket_id']))
        if request.method == 'DELETE':
            deleted.append(ticket['ticket_id'])
        elif ticket is tickets[1]:
            second_validated.set()
        return httpx.Response(200, json=ticket)
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            first_read, release, second_read = asyncio.Event(), asyncio.Event(), asyncio.Event()
            async def first_body():
                first_read.set()
                await release.wait()
                yield json.dumps(quote_task()).encode()
            async def second_body():
                second_read.set()
                yield json.dumps(quote_task()).encode()
            first = asyncio.create_task(client.post('/api/execute', headers=ticket_headers(tickets[0]), content=first_body()))
            await asyncio.wait_for(first_read.wait(), 2)
            second = asyncio.create_task(client.post('/api/execute', headers=ticket_headers(tickets[1]), content=second_body()))
            await asyncio.wait_for(second_validated.wait(), 2)
            await asyncio.sleep(0.01)
            assert not second.done() and not second_read.is_set()
            second.cancel()
            with pytest.raises(asyncio.CancelledError):
                await second
            assert deleted == [tickets[1]['ticket_id']]
            release.set()
            assert (await first).status_code == 200
            assert (await client.post('/api/execute', headers=ticket_headers(tickets[2]), json=quote_task())).status_code == 200
    asyncio.run(run())


def test_overlapping_ticket_failure_does_not_clear_an_active_key():
    first_ticket, second_ticket = ticket_snapshot(), ticket_snapshot()
    started, release = asyncio.Event(), asyncio.Event()
    class Adapter:
        def __init__(self, settings, *, gate_mode):
            pass
        async def execute(self, task, on_preview):
            queue = task.get('_gate_queue')
            if queue and queue['ticket_id'] == second_ticket['ticket_id']:
                raise AdapterError('invalid_image', 'invalid local image')
            if queue:
                queue['submitted'] = True
                started.set()
                await release.wait()
            return [Artifact(b'fixture')]
        async def close(self):
            pass
    async def gate(request):
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'fixture'})
        ticket = first_ticket if request.url.path.endswith(first_ticket['ticket_id']) else second_ticket
        return httpx.Response(200, json=ticket)
    async def run():
        app = create_app('http://gate.fixture', httpx.MockTransport(gate), Adapter)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            first = asyncio.create_task(client.post('/api/execute', headers=ticket_headers(first_ticket), json=quote_task()))
            await asyncio.wait_for(started.wait(), 2)
            second = await client.post('/api/execute', headers=ticket_headers(second_ticket), json=quote_task())
            assert second.status_code == 200 and second.json()['type'] == 'error'
            headers = {'Authorization': 'Bearer valid'}
            blocked = await client.post('/api/execute', headers=headers, json=quote_task())
            assert blocked.status_code == 429 and blocked.json()['reason'] == 'key_busy'
            release.set()
            assert (await first).json()['type'] == 'final'
            assert (await client.post('/api/execute', headers=headers, json=quote_task())).status_code == 200
    asyncio.run(run())


def test_queue_status_includes_image_queue_counts_without_replacing_global():
    raw = {'global': {'active': 2, 'waiting': 1, 'concurrency': 1}, 'image_cooldown_remaining': 0,
           'image_queue': {'queued': 3, 'ready': 1, 'active': 1, 'total': 5, 'capacity': 2}}
    assert gate_bridge._queue_status_payload(raw) == raw
