import assert from "node:assert/strict";
import { snapPixels } from "../src/pixelSnapAlgorithm.ts";

const options = (overrides = {}) => ({
  cellSize: 0,
  avoidOverRefining: true,
  paletteMode: "off",
  paletteSize: 16,
  upscale: false,
  ...overrides,
});

function buffer(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = fill(x, y);
      data.set(color, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function colorForCell(x, y) {
  const index = ((x + y * 3) % 5 + 5) % 5;
  const value = 25 + index * 45;
  return [value, value, value, 255];
}

// A one-pixel left offset and two-pixel top offset exercise phase recovery.
const shifted = buffer(65, 66, (x, y) => {
  const cellX = x < 1 ? 0 : Math.floor((x - 1) / 4) + 1;
  const cellY = y < 2 ? 0 : Math.floor((y - 2) / 4) + 1;
  return colorForCell(cellX, cellY);
});
const shiftedResult = snapPixels(shifted, options());
assert.equal(shiftedResult.pitch, 4);
assert.equal(shiftedResult.confident, true);
assert.ok(shiftedResult.gridWidth >= 16 && shiftedResult.gridWidth <= 17);
assert.ok(shiftedResult.gridHeight >= 16 && shiftedResult.gridHeight <= 17);

// Variable 3/4/5 pixel columns stay close to the repeated four-pixel rhythm.
const variableWidths = [3, 4, 5];
const variableBoundaries = [1];
while (variableBoundaries.at(-1) < 68) {
  const cell = variableBoundaries.length - 1;
  variableBoundaries.push(variableBoundaries.at(-1) + variableWidths[cell % variableWidths.length]);
}
const variable = buffer(69, 64, (x, y) => {
  let cellX = 0;
  while (cellX + 1 < variableBoundaries.length && x >= variableBoundaries[cellX + 1]) cellX++;
  const cellY = Math.floor(y / 4);
  return colorForCell(cellX, cellY);
});
const variableResult = snapPixels(variable, options());
assert.equal(variableResult.pitch, 4);
assert.equal(variableResult.confident, true);
assert.ok(variableResult.gridWidth >= 16 && variableResult.gridWidth <= 18);

const twoPixelGrid = buffer(65, 65, (x, y) => {
  const cellX = x < 1 ? 0 : Math.floor((x - 1) / 2) + 1;
  const cellY = y < 1 ? 0 : Math.floor((y - 1) / 2) + 1;
  const value = (cellX + cellY) % 2 ? 255 : 0;
  return [value, value, value, 255];
});
const twoPixelResult = snapPixels(twoPixelGrid, options());
assert.equal(twoPixelResult.pitch, 2);
assert.equal(twoPixelResult.confident, true);

// Pitch can be inferred from the stronger vertical rhythm while the weaker
// horizontal profile still determines its own independent phase.
const weakXStrongY = buffer(64, 64, (x, y) => {
  const band = Math.floor(y / 4);
  const value = 30 + (band % 5) * 45;
  return x < 2 ? [0, 0, 0, 255] : [value, value, value, 255];
});
const asymmetricResult = snapPixels(weakXStrongY, options());
assert.equal(asymmetricResult.pitch, 4);
assert.equal(asymmetricResult.gridWidth, 17);

// The inner 2x2 pixels carry the cell color; contaminated border pixels must
// not pull the representative toward a dark halo.
const antialiased = buffer(12, 12, (x, y) => {
  const cellX = Math.floor(x / 4);
  const cellY = Math.floor(y / 4);
  if (x % 4 === 0 || x % 4 === 3 || y % 4 === 0 || y % 4 === 3) return [8, 8, 8, 255];
  return colorForCell(cellX, cellY);
});
const antiResult = snapPixels(antialiased, options({ cellSize: 4 }));
assert.equal(antiResult.gridWidth, 3);
assert.equal(antiResult.gridHeight, 3);
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 3; x++) {
    const at = (y * antiResult.width + x) * 4;
    assert.deepEqual([...antiResult.data.slice(at, at + 4)], colorForCell(x, y));
  }
}

// Flat opaque and fully transparent images provide no evidence for a grid.
const flat = buffer(96, 80, () => [41, 82, 123, 255]);
const flatResult = snapPixels(flat, options());
assert.equal(flatResult.pitch, 1);
assert.equal(flatResult.confident, false);
assert.equal(flatResult.gridWidth, flat.width);
assert.deepEqual(flatResult.data, flat.data);

const invisible = buffer(96, 80, (x, y) => [(x * 17) & 255, (y * 29) & 255, (x + y) & 255, 0]);
const invisibleResult = snapPixels(invisible, options());
assert.equal(invisibleResult.pitch, 1);
assert.equal(invisibleResult.confident, false);
assert.deepEqual(invisibleResult.data, invisible.data);

// A strong eight-pixel cell lattice contains a finer two-tone interior. The
// default preserves the detected pitch; opt-in refinement must justify a
// smaller grid by reducing measured reconstruction error.
const refinable = buffer(64, 64, (x, y) => {
  const cellX = Math.floor(x / 8);
  const cellY = Math.floor(y / 8);
  const base = (cellX + cellY) % 2 ? 220 : 30;
  const detail = x % 8 < 4 ? -18 : 18;
  const value = base + detail;
  return [value, value, value, 255];
});
const coarseResult = snapPixels(refinable, options({ avoidOverRefining: true }));
const refinedResult = snapPixels(refinable, options({ avoidOverRefining: false }));
assert.equal(coarseResult.pitch, 8);
assert.equal(refinedResult.pitch, 4);
assert.ok(refinedResult.gridWidth > coarseResult.gridWidth);

const fractionalRefinement = buffer(100, 100, (x, y) => {
  const base = ((Math.floor(x / 5) + Math.floor(y / 5)) % 2) ? 210 : 40;
  const value = base + (x % 5 < 3 ? -10 : 10);
  return [value, value, value, 255];
});
const fractionalResult = snapPixels(fractionalRefinement, options({ avoidOverRefining: false }));
assert.equal(fractionalResult.pitch, 2.5);
assert.ok(Number.isInteger(fractionalResult.width) && Number.isInteger(fractionalResult.height));
assert.ok(fractionalResult.gridWidth * fractionalResult.gridHeight <= fractionalRefinement.width * fractionalRefinement.height);
assert.equal(fractionalResult.data.length, fractionalResult.width * fractionalResult.height * 4);
assert.ok(fractionalResult.data.every((value, index) => index % 4 === 3 ? value === 255 : Number.isInteger(value)));

// Custom palette size one is valid, and alpha must remain byte-for-byte intact.
const paletteSource = buffer(32, 24, (x, y) => [x * 7, y * 9, (x * 11 + y * 3) & 255, (x + y) % 6 === 0 ? 0 : (x * 13 + y * 5) & 255]);
const paletteResult = snapPixels(paletteSource, options({
  cellSize: 1,
  paletteMode: "custom",
  paletteSize: 1,
}));
assert.equal(paletteResult.paletteSize, 1);
const colors = new Set();
for (let at = 0; at < paletteResult.data.length; at += 4) {
  assert.equal(paletteResult.data[at + 3], paletteSource.data[at + 3]);
  if (paletteResult.data[at + 3] >= 8) colors.add(`${paletteResult.data[at]},${paletteResult.data[at + 1]},${paletteResult.data[at + 2]}`);
}
assert.equal(colors.size, 1);

// Auto mode merges near-identical colors until its perceptual error tolerance
// is met, while retaining a separate distant color.
const autoPaletteSource = buffer(30, 30, x => {
  const value = x < 10 ? 60 : x < 20 ? 62 : 220;
  return [value, value, value, 255];
});
const autoPaletteResult = snapPixels(autoPaletteSource, options({
  cellSize: 1,
  paletteMode: "auto",
}));
assert.equal(autoPaletteResult.paletteSize, 2);
const autoColors = new Set();
for (let at = 0; at < autoPaletteResult.data.length; at += 4) {
  autoColors.add(`${autoPaletteResult.data[at]},${autoPaletteResult.data[at + 1]},${autoPaletteResult.data[at + 2]}`);
}
assert.equal(autoColors.size, 2);

// Rare red and blue accents must not disappear into a dominant gold region.
const accentColors = buffer(32, 32, (x, y) => {
  if (x < 28) return [250, 170, 65, 255];
  if (x === 28) return [242, 219, 169, 255];
  if (x === 29) return [124, 220, 212, 255];
  if (x === 30) return [31, 89, 111, 255];
  return y === 31 ? [245, 87, 80, 255] : [43, 158, 167, 255];
});
const accentPalette = snapPixels(accentColors, options({
  cellSize: 1,
  paletteMode: "auto",
}));
assert.ok(accentPalette.paletteSize >= 6);
assert.ok(Array.from({ length: accentPalette.width * accentPalette.height }, (_, index) =>
  [...accentPalette.data.slice(index * 4, index * 4 + 3)].join(","),
).includes("245,87,80"));

// Upscale uses one nearest-neighbor integer factor and returns its actual size.
const blocks = buffer(8, 8, (x, y) => colorForCell(Math.floor(x / 4), Math.floor(y / 4)));
const enlarged = snapPixels(blocks, options({ cellSize: 4, upscale: true }));
assert.equal(enlarged.scale, 4);
assert.equal(enlarged.width, 8);
assert.equal(enlarged.height, 8);
assert.equal(enlarged.gridWidth, 2);
assert.equal(enlarged.gridHeight, 2);
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const sourceColor = colorForCell(Math.floor(x / 4), Math.floor(y / 4));
    const at = (y * enlarged.width + x) * 4;
    assert.deepEqual([...enlarged.data.slice(at, at + 4)], sourceColor);
  }
}

assert.throws(() => snapPixels({ width: 0, height: 1, data: new Uint8ClampedArray(0) }, options()), RangeError);
assert.throws(() => snapPixels({ width: 4097, height: 1, data: new Uint8ClampedArray(4) }, options()), RangeError);
assert.throws(() => snapPixels({ width: 2049, height: 2048, data: new Uint8ClampedArray(0) }, options()), RangeError);
assert.throws(() => snapPixels({ width: 2, height: 2, data: new Uint8ClampedArray(4) }, options()), TypeError);
assert.throws(() => snapPixels(flat, options({ cellSize: 4097 })), RangeError);
assert.throws(() => snapPixels(flat, options({ paletteMode: "custom", paletteSize: 257 })), RangeError);

console.log("Pixel Snap algorithm checks passed.");
