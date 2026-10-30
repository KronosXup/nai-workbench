import assert from 'node:assert/strict';
import * as auth from '../src/auth.ts';

assert.equal(typeof auth.consumeLoginError, 'function', 'Callback errors need a whitelist-only consumer');
const messages = {
  not_registered: '/register', key_reclaimed: '/find', key_disabled: '停用', key_expired: '过期',
  auth_failed: '失败', state_invalid: '失效', service_unavailable: '暂时不可用',
};
for (const [code, expected] of Object.entries(messages)) {
  const url = new URL(`https://ashita.site/workbench/?keep=1&login_error=${code}#draft`);
  const calls = [];
  const history = { state: {keep: true}, replaceState: (...args) => calls.push(args) };
  assert.ok(auth.consumeLoginError(url, history).includes(expected), code);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], history.state);
  assert.equal(calls[0][2], '/workbench/?keep=1#draft');
}
const malicious = 'https://evil.example/<script>alert(1)</script>';
const unknown = auth.consumeLoginError(new URL(`https://ashita.site/workbench/?login_error=${encodeURIComponent(malicious)}`), {state: null, replaceState() {}});
assert.ok(unknown.includes('失败'));
assert.ok(!unknown.includes(malicious));
assert.equal(auth.consumeLoginError(new URL('https://ashita.site/workbench/'), {replaceState() {assert.fail('No error: do not rewrite history');}}), '');
console.log('PASS callback errors: Chinese whitelist only; consume query and preserve route/history');

assert.equal(typeof auth.restoreWorkbenchAccess, 'function', 'Startup needs a cookie session probe, not a default API Key');
let calls = [];
let response = new Response(JSON.stringify({authenticated: true, key: 'must-never-use-this-field'}), {status: 200});
const fetcher = async (url, options) => { calls.push({url, options}); return response; };
assert.equal(await auth.restoreWorkbenchAccess(' existing-key ', fetcher), 'existing-key');
assert.equal(calls.length, 0, 'An existing API Key takes precedence over a cookie');
assert.equal(await auth.restoreWorkbenchAccess('', fetcher), auth.DISCORD_SESSION_ACCESS_TOKEN);
assert.equal(calls.at(-1).url, '/workbench-auth/session');
assert.equal(calls.at(-1).options.credentials, 'same-origin');
assert.equal(calls.at(-1).options.cache, 'no-store');
assert.equal(calls.at(-1).options.redirect, 'error');
assert.equal(calls.at(-1).options.method, 'GET');
assert.equal(calls.at(-1).options.headers, undefined, 'Session probe must not send a Key or marker');
assert.equal(calls.at(-1).options.signal instanceof AbortSignal, true);
for (const status of [401, 403, 404]) {
  response = new Response(null, {status});
  assert.equal(await auth.restoreWorkbenchAccess(auth.DISCORD_SESSION_ACCESS_TOKEN, fetcher), '', `Expired/absent session ${status} must not reconnect the marker`);
}
for (const payload of [{authenticated: false}, {authenticated: 'true'}, {}]) {
  response = new Response(JSON.stringify(payload));
  assert.equal(await auth.restoreWorkbenchAccess('', fetcher), '');
}
response = new Response('private upstream error', {status: 503});
await assert.rejects(auth.restoreWorkbenchAccess('', fetcher), /暂时不可用/);
await assert.rejects(auth.restoreWorkbenchAccess('', async () => {throw new Error('private network details');}), /暂时不可用/);
console.log('PASS restore: API Key priority; cookie-only root probe; stale marker exits; no response credential use');

assert.equal(typeof auth.logoutWorkbenchSession, 'function', 'Logout must revoke the cookie before local reset');
response = new Response(null, {status: 200});
assert.equal(await auth.logoutWorkbenchSession(auth.DISCORD_SESSION_ACCESS_TOKEN, fetcher), true);
assert.equal(calls.at(-1).url, '/workbench-auth/logout');
assert.equal(calls.at(-1).options.method, 'POST');
assert.equal(calls.at(-1).options.credentials, 'same-origin');
assert.equal(calls.at(-1).options.headers['X-Workbench-CSRF'], '1');
assert.equal(calls.at(-1).options.headers.Authorization, undefined);
assert.equal(calls.at(-1).options.cache, 'no-store');
assert.equal(calls.at(-1).options.redirect, 'error');
assert.equal(calls.at(-1).options.signal instanceof AbortSignal, true);
response = new Response(null, {status: 404});
assert.equal(await auth.logoutWorkbenchSession('existing-key', fetcher), false, 'Missing OAuth service must not block legacy Key logout');
await assert.rejects(auth.logoutWorkbenchSession(auth.DISCORD_SESSION_ACCESS_TOKEN, fetcher), /未能确认.*撤销/);
response = new Response(null, {status: 405, headers: {Allow: 'GET'}});
assert.equal(await auth.logoutWorkbenchSession('existing-key', fetcher), false, 'The actual GET catchall 405 also means OAuth is absent for Key-only logout');
await assert.rejects(auth.logoutWorkbenchSession(auth.DISCORD_SESSION_ACCESS_TOKEN, fetcher), /未能确认.*撤销/);
response = new Response('private upstream details', {status: 503});
await assert.rejects(auth.logoutWorkbenchSession('existing-key', fetcher), /未能确认.*撤销/);
await assert.rejects(auth.logoutWorkbenchSession(auth.DISCORD_SESSION_ACCESS_TOKEN, async () => {throw new Error('private network details');}), /未能确认.*撤销/);
console.log('PASS logout: CSRF header, cookie revocation request, honest failure, legacy 404/405 compatibility');
