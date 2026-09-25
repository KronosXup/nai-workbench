import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRequire = createRequire(path.join(clientRoot, "package.json"));
const cache = new Map();
function actualModule(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const source = fs.readFileSync(path.join(clientRoot, "src", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  new Function("exports", "require", compiled)(exports, id =>
    id.startsWith("./") ? actualModule(id.slice(2)) : packageRequire(id));
  return exports;
}

const owner = "http://fixture|A", scope = `${owner}|key-sha256:${"a".repeat(64)}`;
const pixel = new Blob([new Uint8Array([1])], { type: "image/png" });
const records = Array.from({ length: 130 }, (_, index) => {
  const outputHash = index.toString(16).padStart(64, "0");
  return { key: `${scope}:${outputHash}`, scope, outputHash, saved_at: index,
    version: 1, width: 64, height: 64, base: pixel,
    layers: [{ id: 1, name: "图层 1", visible: true, blob: pixel }] };
});
function request(result) {
  const r = { result };
  queueMicrotask(() => r.onsuccess?.());
  return r;
}
function fakeDatabase() {
  return { closed: 0, close() { this.closed++; },
    transaction(store) { return { objectStore() { return { index() { return {
      getAll() { return request(store === "canvasProjects" ? records : []); },
    }; } }; } }; },
  };
}
const opens = [];
globalThis.indexedDB = { open() {
  const r = { result: fakeDatabase() };
  opens.push(r);
  queueMicrotask(() => opens.length === 1 ? r.onblocked?.() : r.onsuccess?.());
  return r;
} };
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    }, error => { this.error = error; this.onerror?.(); });
  }
};

const storage = actualModule("storage");
await assert.rejects(storage.gallery(owner), /刷新该标签页后重试/);
assert.equal((await storage.gallery(owner)).length, 0, "A blocked open must not poison the cached connection");
assert.equal(opens.length, 2);
opens[0].onsuccess();
assert.equal(opens[0].result.closed, 1, "The late success of a rejected open must close its database");
await storage.gallery(owner);
assert.equal(opens.length, 2, "A late success must not replace the working connection");
opens[1].result.onversionchange();
await storage.gallery(owner);
assert.equal(opens.length, 3, "A version-changed connection must reopen on next use");

const backup = await storage.exportBackup(owner, { parameters: {} }, scope);
assert.equal(backup.projects, 128);
assert.equal(backup.omitted, 2);
assert.equal(backup.projectsUnavailable, false);
const json = JSON.parse(await backup.blob.text());
assert.equal(json.canvas_projects.length, 128);
assert.equal(json.canvas_projects_omitted, 2);
assert.equal(json.images.length, 0);
assert.ok(records.every(record => record.base.size === 1), "Backup must not mutate local projects");
console.log("PASS canvas storage: blocked upgrade retry, late-close, version change, 130-project bounded backup");
