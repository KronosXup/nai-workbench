"""Resolve a workbench-only HttpOnly session inside the trusted server bridge.

The browser sends only a public mode marker. Neither the session cookie nor the
original Gate Key is returned to JavaScript or sent to the NovelAI provider.
"""
from __future__ import annotations

import hashlib
import os
import re
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, Request

SESSION_MARKER = '__discord_session__'
SESSION_COOKIE = '__Host-ashita-wb-session'


def _same_origin(request: Request) -> bool:
    """Custom-auth cookie requests must come from this workbench's own origin."""
    origin = request.headers.get('origin')
    if origin is None:
        return request.headers.get('sec-fetch-site') == 'same-origin'
    scheme = request.headers.get('x-forwarded-proto', request.url.scheme)
    host = request.headers.get('x-forwarded-host', request.headers.get('host', ''))
    expected = f'{scheme}://{host}'
    parsed = urlsplit(expected)
    return (scheme in ('http', 'https') and bool(parsed.hostname)
            and parsed.username is None and parsed.password is None
            and origin == expected)


async def resolve_cookie_credential(request: Request, gate_url: str, *, transport=None) -> str:
    session = request.cookies.get(SESSION_COOKIE, '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', session):
        raise HTTPException(401, 'Discord 登录已失效，请重新登录。')
    if not _same_origin(request):
        raise HTTPException(403, 'Discord 登录请求来源无效。')
    secret = os.environ.get('WORKBENCH_AUTH_BRIDGE_SECRET', '')
    if not secret:
        raise HTTPException(503, 'Discord 登录服务暂未配置，请使用 API Key 登录。')
    try:
        async with httpx.AsyncClient(base_url=gate_url, timeout=8,
                                     follow_redirects=False, trust_env=False,
                                     transport=transport) as client:
            response = await client.post('/workbench-auth/resolve',
                headers={'Authorization': 'Bearer ' + secret},
                json={'session_token': session})
    except httpx.HTTPError:
        raise HTTPException(502, 'Discord 登录验证服务暂不可用。') from None
    if response.status_code != 200:
        if response.status_code == 401:
            raise HTTPException(401, 'Discord 登录已失效，请重新登录。')
        if response.status_code == 403:
            raise HTTPException(403, '绑定的 Key 已禁用、过期或被回收；请检查 Key 状态。')
        raise HTTPException(503, 'Discord 登录验证服务暂不可用。')
    try:
        if len(response.content) > 4096:
            raise ValueError('oversized response')
        data = response.json()
        key = data.get('key') if isinstance(data, dict) else None
        if not isinstance(key, str) or not 1 <= len(key) <= 512 or any(not 33 <= ord(c) <= 126 for c in key):
            raise ValueError('invalid credential response')
    except (ValueError, TypeError):
        raise HTTPException(502, 'Discord 登录验证结果无效。') from None
    identity = 'gate-' + hashlib.sha256(key.encode()).hexdigest()
    expected = request.headers.get('x-workbench-identity')
    # Only the initial identity read may be unbound. Every credential-bearing
    # operation must name the identity whose local gallery/queue the tab owns.
    bootstrap = request.method == 'GET' and request.url.path == '/api/me' and expected is None
    if not bootstrap and expected != identity:
        raise HTTPException(401, 'Discord 登录身份已改变，请重新登录。本机图库和草稿仍保留。')
    return key
