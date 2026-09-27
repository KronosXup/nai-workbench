import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRequire = createRequire(path.join(clientRoot, "package.json"));
const ts = packageRequire("typescript");
const source = fs.readFileSync(path.join(clientRoot, "src", "maskGrid.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
new Function("exports", compiled)(exports);
const { expandMaskPixels, hasMaskSelection, maskBrushGridWidth, maskGridSize, moveMaskSelectionPixels, normalizeMaskPixels, paintMaskGridStroke } = exports;

assert.deepEqual(maskGridSize(64, 64), { width: 8, height: 8 });
assert.deepEqual(maskGridSize(65, 63), { width: 9, height: 8 }, "partial edge tiles get their own grid cell");
assert.equal(maskBrushGridWidth(4), 4, "pen size 4 means four mask-grid pixels, independent of display scale");
assert.equal(maskBrushGridWidth(0.8), 1);

const blankBrushGrid = new Uint8ClampedArray(4 * 3 * 4);
for (let offset = 0; offset < blankBrushGrid.length; offset += 4) blankBrushGrid[offset + 3] = 255;
const oneCellRoundStroke = paintMaskGridStroke(blankBrushGrid, 4, 3, { x: 2, y: 1 }, { x: 2, y: 1 }, 1, false, true);
assert.deepEqual([...oneCellRoundStroke.slice((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)], [255, 255, 255, 255], "size-one round click paints one fully selected cell, above the save threshold");
assert.equal(hasMaskSelection(oneCellRoundStroke), true, "a visible one-cell stroke cannot be rejected as an empty mask");
const oneCellSquareStroke = paintMaskGridStroke(blankBrushGrid, 4, 3, { x: 2, y: 1 }, { x: 2, y: 1 }, 1, true, true);
assert.deepEqual([...oneCellSquareStroke.slice((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)], [255, 255, 255, 255], "size-one square click paints exactly one grid cell");
const lineStroke = paintMaskGridStroke(blankBrushGrid, 4, 3, { x: 0, y: 0 }, { x: 3, y: 0 }, 1, true, true);
assert.deepEqual([0, 1, 2, 3].map(x => lineStroke[(x * 4) + 3]), [255, 255, 255, 255], "fast strokes paint contiguous grid cells");

const legacyAlpha = new Uint8ClampedArray([
  255, 255, 255, 0,  // transparent white is unselected in alpha-mask mode
  0, 0, 0, 255,      // opaque black is selected in alpha-mask mode
]);
assert.deepEqual([...normalizeMaskPixels(legacyAlpha, true)], [
  0, 0, 0, 255, 255, 255, 255, 255,
], "legacy transparent masks use alpha coverage");

const legacyOpaque = new Uint8ClampedArray([
  0, 0, 0, 255,
  255, 255, 255, 255,
]);
assert.deepEqual([...normalizeMaskPixels(legacyOpaque, false)], [
  0, 0, 0, 255, 255, 255, 255, 255,
], "legacy opaque masks use brightness");

const grid = new Uint8ClampedArray(9 * 8 * 4);
for (let i = 0; i < grid.length; i += 4) grid[i + 3] = 255;
const selectedCell = (7 * 9 + 8) * 4;
grid.set([255, 255, 255, 255], selectedCell);
const expanded = expandMaskPixels(grid, 9, 8, 65, 64);
assert.equal(expanded.length, 65 * 64 * 4, "saved mask returns to exact source dimensions");
assert.deepEqual([...expanded.slice((63 * 65 + 64) * 4, (63 * 65 + 64) * 4 + 4)],
  [255, 255, 255, 255], "nearest expansion retains the partial right-edge tile");
assert.deepEqual([...expanded.slice((63 * 65 + 56) * 4, (63 * 65 + 56) * 4 + 4)],
  [0, 0, 0, 255], "the selected edge tile does not bleed into its neighbor");
assert.throws(() => expandMaskPixels(grid, 9, 8, 64, 64), /不匹配/);

const selection = new Uint8ClampedArray(4 * 3 * 4);
for (let offset = 0; offset < selection.length; offset += 4) selection.set([0, 0, 0, 255], offset);
selection.set([255, 255, 255, 255], (1 * 4 + 1) * 4);
assert.equal(hasMaskSelection(selection), true);
const moved = moveMaskSelectionPixels(selection, 4, 3, { x: 1, y: 1, width: 1, height: 1 }, 2, 1);
assert.deepEqual([...moved.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)], [0, 0, 0, 255], "mask selection move clears its old cell opaque black");
assert.deepEqual([...moved.slice((2 * 4 + 3) * 4, (2 * 4 + 3) * 4 + 4)], [255, 255, 255, 255], "mask selection move preserves selected cell");
assert.equal(hasMaskSelection(moved), true);
assert.throws(() => moveMaskSelectionPixels(selection, 4, 3, { x: 3, y: 1, width: 1, height: 1 }, 1, 0), /位置无效/);

console.log("Mask grid, legacy import, brush scale, source-size round-trip, selection move, and non-empty validation checks passed.");
