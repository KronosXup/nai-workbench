import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {logoutWorkbenchSession, restoreWorkbenchAccess, DISCORD_SESSION_ACCESS_TOKEN} from '../src/auth.ts';

const require = createRequire(import.meta.url);
const cache = new Map();
function loadClient(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const compiled = ts.transpileModule(fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  new Function('exports', 'require', compiled)(exports, id => id.startsWith('./')
    ? loadClient(id.slice(2)) : require(id));
  return exports;
}
const {ApiError} = loadClient('api');
const {GateApi} = loadClient('gateApi');
const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let disconnect;
const effects = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'disconnect') disconnect = node.initializer.arguments[0];
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect') effects.push(node);
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(disconnect?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), 'The UI must await cookie revocation before resetting local state');
function evaluate(expression, environment) {
  const compiled = ts.transpileModule(`const actual = ${expression};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  return new Function(...Object.keys(environment), `${compiled}; return actual;`)(...Object.values(environment));
}
const flush = async () => {for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));};
async function logoutScenario(status, token = DISCORD_SESSION_ACCESS_TOKEN, pending = false, confirmed = true) {
  const events = [], failures = [];
  let resolveResponse;
  globalThis.fetch = () => {events.push('request'); return new Promise(resolve => {resolveResponse = resolve;});};
  const actual = evaluate(disconnect.getText(file), {
    apiRef: {current: {pending: () => pending}}, token, logoutWorkbenchSession,
    resetConnection: () => events.push('reset'), fail: error => failures.push(error.message),
    setNotice: message => events.push(message), setDisconnecting() {}, disconnectPending: {current: false},
    window: {confirm: () => confirmed},
  });
  const promise = actual();
  assert.equal(events.includes('reset'), false, 'Local identity must stay intact while logout is pending');
  resolveResponse?.(new Response(null, {status}));
  await promise;
  return {events, failures};
}
assert.deepEqual((await logoutScenario(200)).events.slice(0, 2), ['request', 'reset']);
assert.deepEqual((await logoutScenario(503)).events, ['request']);
assert.ok((await logoutScenario(503)).failures[0].includes('未能确认'));
assert.equal((await logoutScenario(404, 'existing-key')).events.includes('reset'), true);
const keyOutage = await logoutScenario(503, 'existing-key');
assert.equal(keyOutage.events.includes('reset'), true, 'API Key logout must clear local identity during an OAuth outage');
assert.equal(keyOutage.failures.length, 0);
assert.ok(keyOutage.events.some(event => event.includes('未能确认')), 'Do not claim the Cookie was revoked');
assert.equal((await logoutScenario(404)).events.includes('reset'), false);
assert.deepEqual((await logoutScenario(200, DISCORD_SESSION_ACCESS_TOKEN, true, false)).events, [], 'Cancel confirmation must not revoke the session');
assert.ok(!source.includes('indexedDB.deleteDatabase'), 'Logout must retain this device gallery, drafts, and canvas projects');
console.log('PASS actual logout callback: confirm first, revoke before reset, keep session on failure, legacy 404, preserve local library');

const sessionEffect = effects.find(node => node.getText(file).includes('restoreWorkbenchAccess(DISCORD_SESSION_ACCESS_TOKEN)'));
assert.ok(sessionEffect, 'An already-open Discord tab must exit when its cookie expires or is revoked elsewhere');
async function monitorScenario(initialStatus, token = DISCORD_SESSION_ACCESS_TOKEN) {
  let status = initialStatus, requests = 0, currentId = 'fixture';
  const events = [], listeners = new Map(), timers = new Set();
  const generation = {current: 7};
  globalThis.fetch = async url => {requests++; return new Response(JSON.stringify(String(url).endsWith('/me') ? {id:currentId} : {authenticated:true}), {status});};
  const actual = evaluate(sessionEffect.arguments[0].getText(file), {
    token, user: {id:'fixture'}, DISCORD_SESSION_ACCESS_TOKEN, restoreWorkbenchAccess, GateApi, ApiError,
    generation, resetConnection: () => {events.push('reset'); generation.current++;},
    fail: error => events.push(error.message), setFailure: message => events.push(message),
    window: {addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)},
    document: {visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)},
    setInterval: fn => {timers.add(fn); return fn;}, clearInterval: fn => timers.delete(fn),
  });
  const cleanup = actual();
  await flush();
  return {events, listeners, timers, cleanup, requests: () => requests, setStatus: value => {status = value;}, setIdentity: value => {currentId = value;}};
}
const expired = await monitorScenario(401);
assert.equal(expired.events[0], 'reset');
assert.ok(expired.events[1].includes('失效'));
expired.cleanup();
assert.equal(expired.listeners.size, 0);
assert.equal(expired.timers.size, 0);
const active = await monitorScenario(200);
assert.deepEqual(active.events, []);
active.setStatus(403);
active.listeners.get('focus')();
await flush();
assert.equal(active.events[0], 'reset', 'Other-tab logout must be detected on focus');
active.cleanup();
const switched = await monitorScenario(200);
switched.setIdentity('other-user');
switched.listeners.get('focus')();
await flush();
assert.equal(switched.events[0], 'reset', 'An authenticated A-to-B cookie switch must reset the stale tab identity/queue');
assert.ok(switched.events[1].includes('身份'));
switched.cleanup();
const offline = await monitorScenario(503);
assert.equal(offline.events.includes('reset'), false, 'Temporary auth outage must not destroy the live connection');
offline.cleanup();
const keyOnly = await monitorScenario(401, 'existing-key');
assert.equal(keyOnly.requests(), 0, 'API Key login does not depend on a Discord cookie');
console.log('PASS actual session monitor effect: expired cookie exits; focus detects other-tab logout; outages retain connection; Key unaffected');
