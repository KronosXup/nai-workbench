import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourceRoot = path.resolve('src');
let page = 'https://ashita.site/workbench/';
const calls = [];
const fakeFetch = async (url) => {
  calls.push(new URL(url, page).href);
  return {ok: true, status: 200, json: async () => ({mode: 'gate'})};
};
const cache = new Map();
function load(relative) {
  const filename = path.resolve(sourceRoot, relative.endsWith('.ts') ? relative : relative + '.ts');
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports: {}};
  cache.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const localRequire = (name) => name === '@huggingface/tokenizers'
    ? {Tokenizer: class TestTokenizer {}}
    : load(path.relative(sourceRoot, path.resolve(path.dirname(filename), name)));
  vm.runInNewContext(compiled, {module, exports: module.exports, require: localRequire,
    fetch: fakeFetch, AbortSignal, URL, console}, {filename});
  return module.exports;
}

await load('connection').verifyGateHealth();
assert.equal(calls.at(-1), 'https://ashita.site/workbench/api/health',
  'Health checks must stay under the workbench prefix');
console.log('PASS prefixed workbench health URL');

const appSource = fs.readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');
const configuredBase = appSource.match(/new GateApi\("([^"]*)", access\.trim\(\)\)/)?.[1];
assert.notEqual(configuredBase, undefined, 'Locate the actual application client configuration');
await new (load('api').Api)(configuredBase, 'non-secret-test-fixture').request('/me');
assert.equal(calls.at(-1), 'https://ashita.site/workbench/api/me',
  'The actual configured API client must retain the workbench prefix');
console.log('PASS prefixed authenticated API client URL');

await load('imageTokenizer').imageTokenizer('qwen');
assert.equal(calls.at(-1), 'https://ashita.site/workbench/tokenizers/qwen.json',
  'Local prompt tokenizers must retain the workbench prefix');
console.log('PASS prefixed local tokenizer URL');

const viteConfig = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
assert.match(viteConfig, /base:\s*["']\.\/["']/,
  'Built HTML, CSS and public assets must use a relative Vite base');
console.log('PASS portable static asset build configuration');

page = 'https://novelaifront.fangchen2003.asia/';
await load('connection').verifyGateHealth();
assert.equal(calls.at(-1), 'https://novelaifront.fangchen2003.asia/api/health');
await new (load('api').Api)(configuredBase, 'non-secret-test-fixture').request('/me');
assert.equal(calls.at(-1), 'https://novelaifront.fangchen2003.asia/api/me');
await load('imageTokenizer').imageTokenizer('clip');
assert.equal(calls.at(-1), 'https://novelaifront.fangchen2003.asia/tokenizers/clip.json');
console.log('PASS legacy root-domain compatibility');
