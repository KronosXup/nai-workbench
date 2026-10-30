# Discord login integration

The client supports both the existing API Key form and Discord cookie sessions. OAuth is a second login method for accounts that already have a valid Gate Key; it does not register users or issue Keys. The login page directs reclaimed-Key users to `/find` and unregistered users to `/register` in Discord.

The existing server-only `WORKBENCH_AUTH_BRIDGE_SECRET` enables Discord login. `/api/health` exposes only a `discord_login` boolean; unconfigured deployments hide the login entry and skip OAuth session probes. Existing Cookie names, OAuth paths and bridge configuration remain supported without another setting.

## Same-origin server contract

- `GET /workbench-auth/discord/start`: the login link navigates to this root path, not `workbench/api/...`.
- `GET /workbench-auth/session`: with `credentials: same-origin`, `cache: no-store`, return only `{ "authenticated": true }` for a valid session; return 401/403 otherwise. Never expose the Key or opaque session token to JavaScript.
- `POST /workbench-auth/logout`: receive same-origin credentials and `X-Workbench-CSRF: 1`; revoke the session and expire its Cookie. A missing session should be an idempotent 200. A Discord logout error retains the current connection and displays a retry message. API Key logout clears the local connection even if this request fails; the UI reports unconfirmed Cookie revocation. Key-only deployments skip this request.
- Callback success returns to `/workbench/`. Failure returns to `/workbench/?login_error=<code>` using only `not_registered`, `key_reclaimed`, `key_disabled`, `key_expired`, `auth_failed`, `state_invalid`, or `service_unavailable`.
- The server owns `__Host-ashita-wb-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). The client never reads or writes it.

`auth.ts` exports the single public `DISCORD_SESSION_ACCESS_TOKEN` marker (`__discord_session__`). Normal API calls still send `Authorization: Bearer __discord_session__`, plus same-origin Cookie credentials. The workbench server must recognize the marker, privately resolve the Cookie session to the user's real Key, and forward the request. The marker is **not a credential**. There is no fallback Key and no client-side Cookie manipulation.

Existing API calls, health checks, tokenizers, and Vite assets retain their relative `/workbench/`-compatible paths. Only the OAuth endpoints use root paths.

## Local data compatibility

The server **must return the same** `me.id = gate-<sha256(realKey)>` in both login modes. Gallery and draft owner remains `${location.origin}|${me.id}`. Discord canvas scope uses the validated lowercase 64-hex digest in `me.id`; API Key canvas scope keeps hashing the actual Key exactly as before. Changing login method for the same Key therefore preserves the existing namespace without merging users.

Startup restores the tab's existing API Key first. With no Key, or with the public marker stored in `sessionStorage`, it probes the session before connecting. Invalid sessions remove the stale marker and leave an operable login form. Active Discord tabs recheck the session on focus, visibility changes, and every 30 seconds while visible; confirmed expiry exits locally while retaining IndexedDB content. Temporary service errors do not silently switch to a Key or erase local data.

Callback errors use fixed Chinese whitelist messages, never arbitrary URL text. `login_error` is consumed with `history.replaceState`, preserving unrelated parameters, hash, and history state.

## Verification

From `client/`, on Node 22:

```sh
set -e
for test in scripts/*.mjs; do
  node --experimental-strip-types "$test"
done
npm run build
```

New scripts cover error consumption, session restoration, the real Api/GateApi transports, actual App startup/logout/session-monitor callbacks, and JSX wiring. `test-canvas-project.mjs` covers identical canvas scope across login modes and invalid identity isolation. Transport fixtures do not generate images. A real Discord authorization/callback and private Gate session resolution still require the integrated backend and configured OAuth credentials.
