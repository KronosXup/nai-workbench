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

const { createCharacterPrompt, enabledCharacterCount, moveCharacter, withUniqueCharacterIds } = actualModule("characterPromptsState");

const female = createCharacterPrompt("female", "female-id");
const male = createCharacterPrompt("male", "male-id");
const other = createCharacterPrompt("other", "other-id");
assert.equal(female.prompt, "girl, ");
assert.equal(male.prompt, "boy, ");
assert.equal(other.prompt, "");
assert.deepEqual([female.x, female.y, female.enabled], [0.5, 0.5, true]);

const roles = [
  { ...female, name: "A", x: 0.2, y: 0.8, remoteField: { retained: true } },
  { ...male, name: "B", enabled: false, x: 0.3, y: 0.7, remoteField: "also retained" },
  { ...other, name: "C", x: 0.4, y: 0.6, ui_id: "duplicate", remoteField: 9 },
  { ...other, name: "D", x: 0.6, y: 0.4, ui_id: "duplicate", remoteField: 10 },
  { ...other, name: "E", x: 0.7, y: 0.3, ui_id: undefined, remoteField: 11 },
];
assert.equal(enabledCharacterCount(roles), 4);

const generated = new WeakMap();
let sequence = 0;
const assignIds = (items) => withUniqueCharacterIds(items, (character, _index, used) => {
  let id = generated.get(character);
  if (!id || used.has(id)) {
    sequence += 1;
    id = `legacy-${sequence}`;
    generated.set(character, id);
  }
  return id;
});
const identified = assignIds(roles);
assert.ok(identified);
assert.equal(identified[0].ui_id, "female-id");
assert.equal(identified[2].ui_id, "duplicate");
assert.notEqual(identified[3].ui_id, "duplicate");
assert.ok(identified[4].ui_id);
assert.deepEqual(identified[0].remoteField, { retained: true });
assert.equal(identified[3].remoteField, 10);
assert.deepEqual(assignIds(identified), null, "unique IDs should not be rewritten");
assert.equal(assignIds(roles)[3].ui_id, identified[3].ui_id, "effect replay should reuse each object's pending ID");

const moved = moveCharacter(roles, 3, 2);
assert.deepEqual(moved.map(item => item.remoteField), [{ retained: true }, "also retained", 10, 9, 11]);
assert.equal(moved[0], roles[0]);
assert.deepEqual([moved[2].name, moved[2].prompt, moved[2].negative_prompt, moved[2].x, moved[2].y],
  [roles[3].name, roles[3].prompt, roles[3].negative_prompt, roles[3].x, roles[3].y]);
assert.equal(moved[1].enabled, false);
assert.equal(moveCharacter(roles, -1, 0), roles, "invalid reorder keeps the existing array");
assert.equal(moveCharacter(roles, 0, roles.length), roles, "out of range reorder keeps the existing array");

console.log("Character prompt state checks passed.");
