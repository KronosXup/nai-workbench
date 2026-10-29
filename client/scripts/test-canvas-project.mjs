import assert from "node:assert/strict";
import { canvasProjectScope, selectCanvasProjectsForBackup, validateCanvasProject } from "../src/canvasProject.ts";

const owner = "http://local.example|user-1";
const a = canvasProjectScope(owner, "gate-key-A");
assert.equal(a, canvasProjectScope(owner, " gate-key-A "));
assert.notEqual(a, canvasProjectScope(owner, "gate-key-B"));
assert.notEqual(a, canvasProjectScope("http://local.example|user-2", "gate-key-A"));
assert.ok(!a.includes("gate-key-A"), "The access key must not appear in the IndexedDB scope");

// A Discord session must reuse the real key digest, never the public marker's digest.
const keyOwner = `https://ashita.site|gate-${a.split('|key-sha256:')[1]}`;
const meId = keyOwner.split('|')[1];
assert.equal(canvasProjectScope(keyOwner, '__discord_session__', meId), canvasProjectScope(keyOwner, 'gate-key-A'),
  'Switching from API Key to Discord must retain the exact canvas scope');
for (const invalidId of ['', 'gate-user', `gate-${'A'.repeat(64)}`, `gate-${'a'.repeat(63)}`, `gate-${'a'.repeat(65)}`, `${meId}\n`]) {
  assert.throws(() => canvasProjectScope(keyOwner, '__discord_session__', invalidId), /身份/);
}
assert.notEqual(canvasProjectScope(`https://ashita.site|gate-${'b'.repeat(64)}`, '__discord_session__', `gate-${'b'.repeat(64)}`),
  canvasProjectScope(keyOwner, '__discord_session__', meId));

const base = new Blob([new Uint8Array([1])], { type: "image/png" });
const layer = new Blob([new Uint8Array([2])], { type: "image/png" });
const valid = { version: 1, width: 64, height: 64, base,
  layers: [{ id: 1, name: "图层 1", visible: true, blob: layer }] };
assert.doesNotThrow(() => validateCanvasProject(valid));
assert.throws(() => validateCanvasProject({ ...valid, width: 4096, height: 4096 }), /尺寸/);
assert.throws(() => validateCanvasProject({ ...valid, layers: [...valid.layers, { ...valid.layers[0] }] }), /图层/);
assert.throws(() => validateCanvasProject({ ...valid, base: new Blob(["x"], { type: "text/plain" }) }), /底图/);
assert.throws(() => validateCanvasProject({ ...valid, layers: [] }), /数量/);

const projects = Array.from({ length: 130 }, (_, index) => ({
  outputHash: index.toString(16).padStart(64, "0"), saved_at: index, base,
  layers: [{ blob: layer }],
}));
const priority = new Map([[projects[0].outputHash, 2], [projects[1].outputHash, 1]]);
const selected = selectCanvasProjectsForBackup(projects, priority);
assert.equal(selected.selected.length, 128);
assert.equal(selected.omitted, 2);
assert.equal(selected.referencedOmitted, 0);
assert.ok(selected.selected.includes(projects[0]), "The active draft's old project must outrank newer orphans");
assert.ok(selected.selected.includes(projects[1]), "A saved job's old source must outrank newer orphans");
const constrained = selectCanvasProjectsForBackup(projects, priority, 1, 2);
assert.equal(constrained.selected[0], projects[0]);
assert.equal(constrained.referencedOmitted, 1);
console.log("PASS canvas project: key isolation, bounds, and prioritized bounded backup selection");
