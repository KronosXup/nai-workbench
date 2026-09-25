import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = require('../client/node_modules/esbuild/lib/main.js');
const entry = resolve(root, 'client/src/storage.ts');
const bundle = await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
const storage = await import(moduleUrl);

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const png = Buffer.from(pngBase64, 'base64');
const pngHash = createHash('sha256').update(png).digest('hex');
const jobParameters = () => ({
  width: 832, height: 1216, steps: 23, scale: 5, seed: -1, sampler: 'k_euler_ancestral',
  n_samples: 1, strength: 0.7, noise: 0, character_prompts: [], reference_image_multiple: [],
  reference_strength_multiple: [], reference_information_extracted_multiple: [], character_reference_images: [],
});
const oldDraft = () => ({
  model: 'nai-diffusion-4-5-full', operation: 'generate', prompt: 'synthetic', artist: '', quality: '', negative: '', count: 1,
  parameters: { ...jobParameters(), legacyParameter: { retained: true } },
  batch: {
    shared: { artist: '', quality: '', negative: '' }, unified: { artist: true, quality: true, negative: true },
    items: Array.from({ length: 5 }, (_, index) => ({ id: `batch-${index}`, prompt: '', artist: '', quality: '', negative: '', count: 1, enabled: true })),
  },
  presets: [], customDraftField: 'preserve-me',
  director: { prompt: 'director fixture', source: { data: pngBase64, width: 1, height: 1, legacySourceField: 'preserve-me' } },
});
const imageRow = (index) => {
  const id = `image-${index}`;
  const jobId = `job-${index}`;
  const result = {
    id, job_id: jobId, media_type: 'image/png', filename: `fixture-${index}.png`,
    sha256: pngHash, size: png.length, expires_at: 0, deleted: false, acknowledged: false, metadata: {},
  };
  const job = {
    id: jobId, request_id: `request-${index}`, operation: 'generate', model: 'nai-diffusion-4-5-full',
    prompt: 'synthetic', negative_prompt: '', parameters: jobParameters(), label: 'fixture', status: 'succeeded',
    created_at: 1, started_at: null, completed_at: null, error: null, results: [result],
    quota_units: 0, storage_mode: 'retain_until_expiry', retention_hours: 0,
  };
  return {
    key: `old-owner:${id}`, owner: 'old-owner', id, job, result, stored_at: index + 1, base64: pngBase64,
    preservedMarker: 'preserve-me',
  };
};
const vibeRow = () => {
  const row = imageRow(900);
  const json = Buffer.from(JSON.stringify({ encoding: 'synthetic-encoding', model: 'nai-diffusion-4-5-full' }));
  row.job.operation = 'encode_vibe';
  row.result.media_type = 'application/json';
  row.result.filename = 'vibe.json';
  row.result.sha256 = createHash('sha256').update(json).digest('hex');
  row.result.size = json.length;
  row.base64 = json.toString('base64');
  return row;
};
const backupFile = value => new File([JSON.stringify(value)], 'synthetic-backup.json', { type: 'application/json' });

const images = new Map();
const drafts = new Map();
const removed = new Map();
const canvasProjects = new Map();
const storeMaps = { images, drafts, removed, canvasProjects };
let openCount = 0;
let transactions = [];
let putCount = 0;
let deleteCount = 0;

function request(result) {
  const item = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => item.onsuccess?.({ target: item }));
  return item;
}

const database = {
  objectStoreNames: { contains: name => Object.hasOwn(storeMaps, name) },
  transaction(names, mode = 'readonly') {
    transactions.push({ names: Array.isArray(names) ? names : [names], mode });
    let aborted = false;
    const tx = {
      error: null, oncomplete: null, onerror: null, onabort: null,
      objectStore(name) {
        const map = storeMaps[name];
        assert.ok(map, `unexpected store ${name}`);
        return {
          put(value) {
            putCount++;
            const key = name === 'drafts' ? value.owner : value.key;
            map.set(key, value);
            return request(key);
          },
          delete(key) { deleteCount++; map.delete(key); return request(undefined); },
          get(key) { return request(map.get(key)); },
          index() { return { getAll: () => request([...map.values()]) }; },
        };
      },
      abort() {
        aborted = true;
        queueMicrotask(() => tx.onabort?.({ target: tx }));
      },
    };
    setTimeout(() => {
      if (!aborted) tx.oncomplete?.({ target: tx });
    }, 0);
    return tx;
  },
};

globalThis.indexedDB = {
  open() {
    openCount++;
    const item = { result: database, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => item.onsuccess?.({ target: item }));
    return item;
  },
};

const assertNoDatabaseActivity = async (malformed, expectedDraftFailure) => {
  const priorOpens = openCount;
  const priorTransactions = transactions.length;
  await assert.rejects(storage.importBackup('new-owner', backupFile(malformed)), error => {
    if (expectedDraftFailure) {
      assert.equal(error.message, '备份中的绘图草稿不完整或已损坏，导入已取消。');
      assert.equal(error.path, expectedDraftFailure);
    } else assert.match(error.message, /导入已取消|格式无效|不完整/);
    return true;
  });
  assert.equal(openCount, priorOpens, 'a rejected backup must not open IndexedDB');
  assert.equal(transactions.length, priorTransactions, 'a rejected backup must not start a transaction');
};

const invalidDraftBackup = { format: 'nai-workbench-backup', version: 1, draft: { ...oldDraft(), parameters: {} }, images: [imageRow(1)] };
await assertNoDatabaseActivity(invalidDraftBackup, '生成参数.width');

const malformedArrayBackup = structuredClone(invalidDraftBackup);
malformedArrayBackup.draft = oldDraft();
malformedArrayBackup.draft.batch.items[2] = {};
await assertNoDatabaseActivity(malformedArrayBackup, '批量项目[2].id');

const invalidImageBackup = { format: 'nai-workbench-backup', version: 1, draft: oldDraft(), images: [imageRow(2)] };
invalidImageBackup.images[0].result.media_type = 'image/jpeg';
await assertNoDatabaseActivity(invalidImageBackup);

const invalidJsonTypeBackup = { format: 'nai-workbench-backup', version: 1, draft: oldDraft(), images: [imageRow(3)] };
const syntheticJson = Buffer.from('{"encoding":"synthetic"}');
invalidJsonTypeBackup.images[0].result.media_type = 'application/json';
invalidJsonTypeBackup.images[0].result.filename = 'not-vibe.json';
invalidJsonTypeBackup.images[0].result.sha256 = createHash('sha256').update(syntheticJson).digest('hex');
invalidJsonTypeBackup.images[0].result.size = syntheticJson.length;
invalidJsonTypeBackup.images[0].base64 = syntheticJson.toString('base64');
await assertNoDatabaseActivity(invalidJsonTypeBackup);

const validBackup = {
  format: 'nai-workbench-backup', version: 1, draft: oldDraft(),
  images: Array.from({ length: 42 }, (_, index) => imageRow(index)),
};
const imported = await storage.importBackup('new-owner', backupFile(validBackup));
assert.equal(imported.count, 42, '42 synthetic images from an older backup should import');
assert.equal(images.size, 42);
assert.equal(drafts.size, 1);
assert.equal(putCount, 43);
assert.equal(deleteCount, 42);
const restored = drafts.get('new-owner').draft;
assert.equal(restored.customDraftField, 'preserve-me', 'unknown draft fields should survive');
assert.equal(restored.director.source.legacySourceField, 'preserve-me', 'unknown director-source fields should survive');
assert.equal(restored.parameters.legacyParameter.retained, true, 'unknown parameter fields should survive');
assert.deepEqual(restored.parameters.character_reference_descriptions, [], 'new optional fields should get defaults');
assert.equal(images.get('new-owner:image-0').preservedMarker, 'preserve-me', 'unknown image-record fields should survive');
assert.equal(images.get('new-owner:image-0').base64, undefined, 'transport Base64 should not be duplicated in IndexedDB');
const importedVibe = await storage.importBackup('new-owner', backupFile({
  format: 'nai-workbench-backup', version: 1, draft: oldDraft(), images: [vibeRow()],
}));
assert.equal(importedVibe.count, 1, 'legacy encode_vibe JSON results should import');
assert.equal(images.get('new-owner:image-900').blob.type, 'application/json');
const readableDraft = await storage.readDraft('new-owner');
assert.equal(readableDraft.customDraftField, 'preserve-me');
assert.deepEqual(readableDraft.parameters.character_reference_fidelities, []);

const beforeReadWrites = { putCount, deleteCount };
drafts.set('new-owner', { owner: 'new-owner', draft: { ...oldDraft(), parameters: {}, batch: { items: [{}, {}, {}, {}, {}] } } });
await assert.rejects(storage.readDraft('new-owner'), error => {
  assert.ok(error instanceof storage.InvalidDraftError);
  assert.equal(error.message, '绘图草稿不完整或已损坏。');
  assert.equal(error.path, '生成参数.width');
  return true;
});
assert.deepEqual({ putCount, deleteCount }, beforeReadWrites, 'readDraft must not repair or delete malformed persisted data');
assert.equal(images.size, 43, 'bad persisted drafts must leave the gallery intact');
assert.equal(transactions.at(-1).mode, 'readonly');

console.log('backup validation passed: malformed imports start no transaction; malformed drafts stay untouched; 42 legacy images and one legacy Vibe JSON result import; unknown fields survive.');
