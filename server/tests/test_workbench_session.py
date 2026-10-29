import asyncio
import hashlib
import json

import httpx

from app.gate_bridge import create_app

MARKER = '__discord_session__'
COOKIE = '__Host-ashita-wb-session'
SESSION = 'fixture-session-' + 'a' * 40
KEY = 'nai-fixture-existing-key-123456789'
SECRET = 'fixture-private-session-bridge'


def environment(monkeypatch, *, resolve_status=200, resolve_body=None, sessions=None):
    monkeypatch.setenv('WORKBENCH_AUTH_BRIDGE_SECRET', SECRET)
    calls = []

    async def gate(request):
        calls.append((request.url.path, request.headers.get('authorization')))
        if request.url.path == '/workbench-auth/resolve':
            assert request.headers.get('authorization') == 'Bearer ' + SECRET
            if sessions is not None:
                session_token = json.loads(request.content)['session_token']
                assert session_token in sessions
                return httpx.Response(200, json={'key': sessions[session_token]})
            assert json.loads(request.content) == {'session_token': SESSION}
            return httpx.Response(resolve_status, json=resolve_body or {'key': KEY})
        expected_keys = sessions.values() if sessions is not None else (KEY,)
        if request.headers.get('authorization') not in {'Bearer ' + key for key in expected_keys}:
            return httpx.Response(401, json={'detail': 'fixture invalid credential'})
        if request.url.path == '/user/information':
            return httpx.Response(200, json={'username': 'existing-user'})
        if request.url.path == '/user/subscription':
            return httpx.Response(200, json={'naiGate': {
                'anlasMonthlyLimit': 0, 'anlasLeft': 0, 'v5LeftToday': 21,
                'v5DailyLimit': 30, 'freeOnly': True,
            }})
        if request.url.path == '/v1/me':
            return httpx.Response(200, json={'is_admin': False, 'today': {
                'daily_images': 100, 'legacy_free_images_today': 4,
            }})
        raise AssertionError('Unexpected path ' + request.url.path)

    return create_app('http://gate.fixture', httpx.MockTransport(gate)), calls


def test_cookie_login_resolves_key_only_on_server_and_preserves_user_identity(monkeypatch):
    async def run():
        app, calls = environment(monkeypatch)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            response = await client.get('/api/me', headers={
                'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                'Sec-Fetch-Site': 'same-origin', 'Cookie': COOKIE + '=' + SESSION,
            })
            assert response.status_code == 200, response.text
            data = response.json()
            assert data['id'] == 'gate-' + hashlib.sha256(KEY.encode()).hexdigest()
            assert data['gate_quota']['legacyFree']['leftToday'] == 96
            assert data['gate_quota']['v5LeftToday'] == 21
            assert calls[0][0] == '/workbench-auth/resolve'
            for secret in [KEY, SESSION, SECRET, MARKER]:
                assert secret not in response.text
            direct = await client.get('/api/me', headers={
                'Authorization': 'Bearer ' + KEY,
                'Cookie': COOKIE + '=' + SESSION,
            })
            assert direct.status_code == 200
            assert direct.json()['id'] == data['id']
            assert sum(path == '/workbench-auth/resolve' for path, _ in calls) == 1
    asyncio.run(run())


def test_shared_cookie_switch_rejects_stale_identity_before_any_dispatch(monkeypatch):
    async def run():
        session_b = 'fixture-session-' + 'b' * 40
        app, calls = environment(monkeypatch, sessions={SESSION: KEY, session_b: KEY + '-other-user'})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            headers = {'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                       'Cookie': COOKIE + '=' + SESSION}
            first = await client.get('/api/me', headers=headers)
            assert first.status_code == 200
            identity_a = first.json()['id']
            # Another tab switches the shared cookie to B's session. The public
            # marker and A's established local namespace stay the same.
            headers['Cookie'] = COOKIE + '=' + session_b
            current = await client.get('/api/me', headers=headers)
            assert current.status_code == 200
            identity_b = current.json()['id']
            assert identity_b != identity_a
            for path, body in (('/api/quote', {}), ('/api/execute', {'operation': 'generate'}),
                               ('/api/execute', {'operation': 'encode_vibe'}),
                               ('/api/suggest-tags', {}), ('/api/me', None), ('/api/queue-status', None)):
                calls.clear()
                response = await client.request('GET' if body is None else 'POST', path,
                    headers={**headers, 'X-Workbench-Identity': identity_a}, json=body)
                assert response.status_code == 401, (path, response.text)
                assert calls == [('/workbench-auth/resolve', 'Bearer ' + SECRET)]
                assert 'previous-user-key' not in response.text and KEY not in response.text
            # Identity-less dispatch cannot silently opt out of the protection.
            calls.clear()
            missing = await client.post('/api/execute', headers=headers, json={})
            assert missing.status_code == 401
            assert all(path == '/workbench-auth/resolve' for path, _ in calls)
            good = await client.get('/api/me', headers={**headers, 'X-Workbench-Identity': identity_b})
            assert good.status_code == 200
            assert good.json()['id'] == identity_b
    asyncio.run(run())


def test_cookie_auth_rejects_cross_origin_and_missing_browser_provenance(monkeypatch):
    async def run():
        app, calls = environment(monkeypatch)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            for extra in ({'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'},
                          {'Origin': 'null'}, {'Sec-Fetch-Site': 'same-site'}, {}):
                response = await client.get('/api/me', headers={
                    'Authorization': 'Bearer ' + MARKER, 'Cookie': COOKIE + '=' + SESSION, **extra})
                assert response.status_code == 403
                assert calls == []
            good = await client.get('/api/me', headers={
                'Authorization': 'Bearer ' + MARKER, 'Cookie': COOKIE + '=' + SESSION,
                'Sec-Fetch-Site': 'same-origin'})
            assert good.status_code == 200
    asyncio.run(run())


def test_ordinary_gate_without_oauth_returns_405_for_logout(monkeypatch):
    async def run():
        app, calls = environment(monkeypatch)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            response = await client.post('/workbench-auth/logout', headers={'X-Workbench-CSRF': '1'})
            assert response.status_code == 405  # GET-only static catchall, not OAuth.
            assert response.headers['allow'] == 'GET'
            assert calls == []
    asyncio.run(run())


def test_missing_or_malformed_cookie_never_reaches_gate(monkeypatch):
    async def run():
        app, calls = environment(monkeypatch)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            for cookie in ('', 'short', 'x' * 257):
                response = await client.get('/api/me', headers={
                    'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                    'Cookie': COOKIE + '=' + cookie})
                assert response.status_code == 401
                assert calls == []
            cookie_only = await client.get('/api/me', headers={
                'Cookie': COOKIE + '=' + SESSION, 'Origin': 'https://ashita.site'})
            assert cookie_only.status_code == 401
            assert calls == []
    asyncio.run(run())


def test_unconfigured_private_bridge_fails_closed_without_changing_key_mode(monkeypatch):
    async def run():
        app, calls = environment(monkeypatch)
        monkeypatch.delenv('WORKBENCH_AUTH_BRIDGE_SECRET')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
            response = await client.get('/api/me', headers={
                'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                'Cookie': COOKIE + '=' + SESSION})
            assert response.status_code == 503
            assert calls == []
            direct = await client.get('/api/me', headers={'Authorization': 'Bearer ' + KEY})
            assert direct.status_code == 200
    asyncio.run(run())


def test_private_resolver_errors_are_sanitized_and_not_retried(monkeypatch):
    async def run():
        for status in (401, 403, 500):
            app, calls = environment(monkeypatch, resolve_status=status, resolve_body={
                'detail': KEY + SESSION + SECRET})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
                response = await client.get('/api/me', headers={
                    'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                    'Cookie': COOKIE + '=' + SESSION})
                assert response.status_code == (status if status in (401, 403) else 503)
                assert len(calls) == 1
                for secret in (KEY, SESSION, SECRET):
                    assert secret not in response.text
    asyncio.run(run())


def test_invalid_private_resolver_payload_is_not_forwarded(monkeypatch):
    async def run():
        for body in ({'key': None}, {'key': 'unsafe\ncredential'}, {'key': 'x' * 513}, {'key': KEY, 'padding': 'x' * 5000}):
            app, calls = environment(monkeypatch, resolve_body=body)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://ashita.site') as client:
                response = await client.get('/api/me', headers={
                    'Authorization': 'Bearer ' + MARKER, 'Origin': 'https://ashita.site',
                    'Cookie': COOKIE + '=' + SESSION})
                assert response.status_code == 502
                assert len(calls) == 1
    asyncio.run(run())
