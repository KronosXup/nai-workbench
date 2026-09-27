import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const packageRequire = createRequire(path.join(clientRoot, "package.json"));
const ts = packageRequire("typescript");
const cache = new Map();

function actualModule(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const source = fs.readFileSync(path.join(clientRoot, "src", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", compiled)(exports, id =>
    id.startsWith("./") ? actualModule(id.slice(2)) : packageRequire(id));
  return exports;
}

const { directorSourceIssue, readDirectorDraft, directorTask } = actualModule("director");
const source = { data: "eA==", width: 1024, height: 1024, name: "fixture.png" };

assert.equal(directorSourceIssue(source), undefined, "ordinary director image is accepted");
assert.equal(directorSourceIssue({ ...source, width: 2048, height: 1536 }), undefined,
  "the exact 3,145,728-pixel limit is accepted");
assert.match(directorSourceIssue({ ...source, width: 9000, height: 100 }), /长边不超过 8192/,
  "long-edge limit is enforced even when total pixels fit");
assert.match(directorSourceIssue({ ...source, width: 32, height: 2048 }), /短边至少 64/,
  "short-edge limit is enforced even when total pixels fit");
assert.match(directorSourceIssue({ ...source, width: 2049, height: 1536 }), /总像素不超过 3145728/,
  "pixel-area limit is enforced independently");
assert.equal(directorSourceIssue({ ...source, width: 8192, height: 384 }), undefined,
  "the exact long-edge and pixel-area limits are accepted");
assert.match(directorSourceIssue({ ...source, width: 0, height: 64 }), /图片尺寸无效/,
  "non-positive dimensions are rejected");

console.log("Director source dimension checks passed.");

const legacyDirector = {tool: 'declutter-keep-bubbles', source, prompt: 'retained note'};
const migratedDirector = readDirectorDraft(legacyDirector);
assert.equal(migratedDirector.tool, 'declutter');
assert.deepEqual(migratedDirector.source, source);
assert.equal(migratedDirector.prompt, 'retained note');
assert.equal(directorTask(migratedDirector).parameters.req_type, 'declutter');
assert.equal(legacyDirector.tool, 'declutter-keep-bubbles', 'migration does not mutate old history');
console.log('Legacy director tool restores as standard Declutter without losing source or prompt.');
