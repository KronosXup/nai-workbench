import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRequire = createRequire(path.join(root, 'package.json'));
const cache = new Map();
function load(name) {
  name = name.replace(/\.ts$/, '');
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const source = fs.readFileSync(path.join(root, 'src', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  new Function('exports', 'require', compiled)(exports, id =>
    id.startsWith('./') ? load(id.slice(2)) : packageRequire(id));
  return exports;
}

const downloads = [];
const urls = new Map();
const timers = [];
const revoked = [];
const fixedTime = new Date('2026-10-24T06:25:42.446Z').getTime();
const NativeDate = globalThis.Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return fixedTime; }
};
globalThis.document = { createElement(tag) {
  assert.equal(tag, 'a');
  return { click() { downloads.push({ name: this.download, blob: urls.get(this.href) }); } };
} };
URL.createObjectURL = blob => { const url = `blob:test-${urls.size}`; urls.set(url, blob); return url; };
URL.revokeObjectURL = url => revoked.push(url);
globalThis.setTimeout = (fn, delay) => { assert.equal(delay, 5000); timers.push(fn); };

const { download } = load('storage');
const png = new Blob(['unchanged PNG bytes and metadata'], {type: 'image/png'});
for (let i = 0; i < 100; i++) download(png, 'image_0.png');
for (const result of downloads) {
  assert.match(result.name, /^nai-20261024T062542446Z-[a-f0-9-]{36}\.png$/,
    'Generated image downloads need a sortable timestamp and random UUID, not image_0.png');
  assert.equal(result.blob, png, 'Download must use the original blob without changing metadata');
}
assert.equal(new Set(downloads.map(row => row.name)).size, 100,
  'Different images or repeated clicks within the same millisecond must not collide');
console.log('PASS 100 collision-free image downloads with original bytes');

for (const [name, type, extension] of [
  ['old-image.JPG', 'image/jpeg', 'jpg'],
  ['result.webp', 'image/webp', 'webp'],
  ['image_0.png', '', 'png'],
  ['artifact', 'image/png', 'png'],
]) {
  download(new Blob(['original'], {type}), name);
  assert.match(downloads.at(-1).name, new RegExp(`^nai-.*\\.${extension}$`));
}
console.log('PASS image extensions and old gallery downloads');

for (const name of ['nai-backup-part-001.json', 'references.naiv4vibe', 'vibes.zip']) {
  download(new Blob(['original'], {type: 'application/octet-stream'}), name);
  assert.equal(downloads.at(-1).name, name, 'Non-image exports must keep their filenames');
}
for (const fn of timers) fn();
assert.equal(revoked.length, downloads.length);
console.log('PASS backup/vibe filenames and object URL cleanup preserved');
