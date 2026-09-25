import assert from "node:assert/strict";
import { colorizeMask, floodFillMask, moveLayerSelection } from "../src/canvasPixels.ts";

function rgba(...pixels) {
  return new Uint8ClampedArray(pixels.flat());
}

const separated = rgba(
  [10, 10, 10, 255], [34, 10, 10, 255], [35, 10, 10, 255],
  [10, 10, 10, 255], [10, 10, 10, 255], [10, 10, 10, 255],
);
const toleranceMask = floodFillMask(separated, 3, 2, 0, 0, 24);
assert.deepEqual([...toleranceMask], [1, 1, 0, 1, 1, 1], "tolerance includes the exact boundary and flood remains four-connected");
const recolored = colorizeMask(separated, toleranceMask, [80, 90, 100, 255]);
assert.deepEqual([...recolored.slice(0, 4)], [80, 90, 100, 255]);
assert.deepEqual([...recolored.slice(8, 12)], [35, 10, 10, 255], "pixels outside the selected region are preserved");
assert.deepEqual([...separated.slice(0, 4)], [10, 10, 10, 255], "fill keeps its source snapshot intact for undo");

const transparency = rgba(
  [220, 5, 9, 0], [0, 0, 0, 0], [0, 0, 0, 255],
  [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
);
assert.deepEqual([...floodFillMask(transparency, 3, 2, 0, 0, 0)], [1, 1, 0, 1, 1, 1],
  "fully transparent pixels connect regardless of their hidden RGB bytes");
const diagonalOnly = rgba([12, 12, 12, 255], [200, 0, 0, 255], [200, 0, 0, 255], [12, 12, 12, 255]);
assert.deepEqual([...floodFillMask(diagonalOnly, 2, 2, 0, 0, 0)], [1, 0, 0, 0],
  "diagonal-only pixels do not join a four-connected fill region");

const layer = rgba(
  [0, 0, 0, 0], [200, 20, 10, 255], [0, 0, 0, 0], [0, 0, 0, 0],
  [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
);
const beforeMove = new Uint8ClampedArray(layer);
const afterMove = moveLayerSelection(layer, 4, 2, { x: 1, y: 0, width: 1, height: 1 }, 2, 1);
assert.deepEqual([...afterMove.slice((1 * 4 + 3) * 4, (1 * 4 + 3) * 4 + 4)], [200, 20, 10, 255], "selection content moves to its new location");
assert.deepEqual([...afterMove.slice(4, 8)], [0, 0, 0, 0], "selection source becomes transparent");
assert.deepEqual([...beforeMove], [...layer], "captured before pixels remain available as an undo snapshot");
assert.deepEqual([...beforeMove], [...moveLayerSelection(afterMove, 4, 2, { x: 3, y: 1, width: 1, height: 1 }, -2, -1)],
  "undo snapshot restores the original pixels after a committed move");

const overlapping = rgba(
  [0, 0, 0, 255], [220, 0, 0, 255], [0, 210, 0, 255], [0, 0, 200, 255],
);
const overlapResult = moveLayerSelection(overlapping, 4, 1, { x: 1, y: 0, width: 2, height: 1 }, 1, 0);
assert.deepEqual([...overlapResult], [
  0, 0, 0, 255, 0, 0, 0, 0, 220, 0, 0, 255, 0, 210, 0, 255,
], "overlapping move copies both selected pixels from the original snapshot without losing either");

const edgeSelection = rgba(
  [0, 0, 0, 0], [0, 0, 0, 0], [230, 20, 20, 255], [20, 230, 20, 255],
);
const clipped = moveLayerSelection(edgeSelection, 4, 1, { x: 2, y: 0, width: 2, height: 1 }, 1, 0);
assert.deepEqual([...clipped], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 230, 20, 20, 255],
  "content shifted past the right edge is clipped and the full source selection is cleared");

console.log("Canvas pixel algorithms passed: fill tolerance, transparency, connectivity, overlapping and clipped moves, and undo snapshots.");
