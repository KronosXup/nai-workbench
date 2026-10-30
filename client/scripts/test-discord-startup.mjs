import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {restoreWorkbenchAccess, consumeLoginError, DISCORD_SESSION_ACCESS_TOKEN} from '../src/auth.ts';

const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let startup;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.getText(file).includes('connect(') && node.getText(file).includes('generation.current++')) startup = node.getText(file);
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(startup, 'Locate the actual startup effect');
const compiled = ts.transpileModule(startup, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
async function runStartup(token, status = 200, loginError = '', rememberDevice = false, discordEnabled = true) {
  const connected = [], remembered = [], failures = [], values = [], busy = [], enabled = [], requests = [];
  const store = new Map(token ? [['nai-wb-token', token]] : []);
  const generation = {current: 0};
  let effect;
  globalThis.fetch = async url => {requests.push(url); return new Response(JSON.stringify({authenticated: true}), {status});};
  const environment = {
    useEffect: callback => {effect = callback;}, token, loginError, generation, rememberDevice,
    connect: async (access, remember) => { connected.push(access); remembered.push(remember); }, restoreWorkbenchAccess, consumeLoginError, DISCORD_SESSION_ACCESS_TOKEN,
    verifyGateHealth: async () => ({discordLoginEnabled: discordEnabled}), setDiscordLoginEnabled: value => enabled.push(value),
    setFailure: value => failures.push(value), fail: error => failures.push(error.message),
    setConnecting: value => busy.push(value), setToken: value => values.push(value),
    sessionStorage: {removeItem: key => store.delete(key)},
    location: new URL('https://ashita.site/workbench/'), history: {state: null, replaceState() {}},
  };
  new Function(...Object.keys(environment), compiled)(...Object.values(environment));
  const cleanup = effect();
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  return {connected, remembered, failures, values, busy, enabled, requests, store, cleanup};
}
assert.deepEqual((await runStartup('existing-key')).connected, ['existing-key']);
assert.deepEqual((await runStartup('existing-key', 200, '', true)).remembered, [true], 'Restore an explicitly remembered API Key without dropping the setting');
assert.deepEqual((await runStartup('', 200, '', true)).remembered, [false], 'A Discord session marker must never be remembered as a persistent API Key');
assert.deepEqual((await runStartup('')).connected, [DISCORD_SESSION_ACCESS_TOKEN],
  'No stored Key: connect the public marker only after a valid cookie session probe');
for (const status of [401, 403, 404]) {
  const result = await runStartup(DISCORD_SESSION_ACCESS_TOKEN, status);
  assert.deepEqual(result.connected, [], `Stale marker ${status} must not reconnect`);
  assert.equal(result.store.has('nai-wb-token'), false, 'Discard stale marker from tab storage');
  assert.equal(result.busy.at(-1), false, 'An expired cookie must leave an operable login page');
}
const down = await runStartup('', 503);
assert.equal(down.connected.length, 0);
assert.ok(down.failures.at(-1).includes('暂时不可用'));
assert.equal(down.busy.at(-1), false);
const callbackFailure = await runStartup('', 200, 'Discord 登录失败，请重试。');
assert.equal(callbackFailure.connected.length, 0, 'Keep the callback error visible instead of clearing it with autologin');
assert.equal(callbackFailure.enabled.at(-1), true, 'Configured Discord login must remain available after a callback error');
for (const stored of ['', DISCORD_SESSION_ACCESS_TOKEN]) {
  const disabled = await runStartup(stored, 200, '', false, false);
  assert.deepEqual(disabled.connected, [], 'An unconfigured deployment must not restore a Discord session');
  assert.equal(disabled.enabled.at(-1), false);
  assert.equal(disabled.requests.length, 0, 'Key-only deployments must not probe missing OAuth endpoints');
  assert.equal(disabled.store.has('nai-wb-token'), false);
}
assert.equal((await runStartup('existing-key')).requests.length, 0, 'Stored API Keys do not depend on OAuth');
console.log('PASS actual startup effect: Key first, cookie restore, expired marker clears without loop, callback error retained');
