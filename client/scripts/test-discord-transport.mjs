import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRequire = createRequire(path.join(root, 'package.json'));
const cache = new Map();
function load(name) {
  name = name.replace(/\.ts$/, '');
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src', `${name}.ts`), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  new Function('exports', 'require', compiled)(exports, id => id.startsWith('./') ? load(id.slice(2)) : packageRequire(id));
  return exports;
}
const {DISCORD_SESSION_ACCESS_TOKEN} = load('auth');
const {Api, ApiError} = load('api');
const {GateApi} = load('gateApi');
let status = 200;
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({url, options});
  return new Response(JSON.stringify(status === 200 ? {id:'transport-fixture'} : {detail:'Expired session'}), {status});
};
const client = new GateApi('.', DISCORD_SESSION_ACCESS_TOKEN);
await client.request('/me');
assert.equal(calls.at(-1).url, './api/me');
assert.equal(calls.at(-1).options.credentials, 'same-origin', 'Session-backed API calls must include same-origin cookies');
assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${DISCORD_SESSION_ACCESS_TOKEN}`);
assert.equal(calls.at(-1).options.headers['X-Workbench-Identity'], undefined, 'First /me bootstraps the tab identity');
const quoteTask = {operation: 'generate', model: 'nai-diffusion-4-5-full', parameters: {width: 832, height: 1216, prompt: 'private prompt', image: 'private pixels'}};
await client.request('/quote', quoteTask);
assert.equal(calls.at(-1).options.headers['X-Workbench-Identity'], 'transport-fixture', 'JSON calls must stay bound to the established identity');
const quoteBody = JSON.parse(calls.at(-1).options.body);
assert.equal(quoteBody.operation, 'generate-image');
assert.equal(quoteBody.parameters.width, 832);
assert.equal(quoteBody.parameters.prompt, undefined, 'Transport must send only pricing metadata');
assert.equal(quoteBody.parameters.image, undefined, 'Quote transport must not upload pixels');
assert.ok(Buffer.byteLength(calls.at(-1).options.body) <= 4096);
await client.raw('/transport-check');
assert.equal(calls.at(-1).url, './api/transport-check');
assert.equal(calls.at(-1).options.credentials, 'same-origin', 'Streaming transport must also include cookies');
assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${DISCORD_SESSION_ACCESS_TOKEN}`);
assert.equal(calls.at(-1).options.headers['X-Workbench-Identity'], 'transport-fixture', 'Streaming dispatch must use the same identity binding');
// A later successful identity response must not silently rebind an existing client.
const changing = new Api('.', DISCORD_SESSION_ACCESS_TOKEN);
await changing.request('/me');
globalThis.fetch = async (url, options) => {calls.push({url, options}); return new Response(JSON.stringify({id:'other-user'}));};
await assert.rejects(changing.request('/me'), e => e instanceof ApiError && e.status === 401);
await changing.request('/quote', {});
assert.equal(calls.at(-1).options.headers['X-Workbench-Identity'], 'transport-fixture');
globalThis.fetch = async (url, options) => {calls.push({url, options}); return new Response(JSON.stringify({detail:'Expired session'}), {status});};
status = 401;
await assert.rejects(client.request('/capabilities'), e => e instanceof ApiError && e.status === 401);
assert.equal(client.accessToken, DISCORD_SESSION_ACCESS_TOKEN, 'Transport must never replace marker with a default Key');
const keyClient = new Api('.', 'existing-key');
await assert.rejects(keyClient.request('/me'), e => e.status === 401);
assert.equal(keyClient.accessToken, 'existing-key', 'Transport must not clear the API Key either');
console.log('PASS real Api/GateApi transports: relative subpath, cookie credentials, public marker, no credential fallback');
