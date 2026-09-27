const MASK_GRID_DIVISOR = 8;
const MASK_THRESHOLD = 155;

export function maskBrushGridWidth(value: number) {
  if (!Number.isFinite(value)) throw new RangeError("笔刷大小无效。");
  return Math.max(1, Math.min(256, Math.floor(value)));
}

/** Paint binary mask cells directly so a one-cell click cannot anti-alias below the save threshold. */
export function paintMaskGridStroke(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  brushSize: number,
  square: boolean,
  selected: boolean,
) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      pixels.length !== width * height * 4 ||
      ![from.x, from.y, to.x, to.y, brushSize].every(Number.isInteger) || brushSize < 1 || brushSize > 256) {
    throw new RangeError("蒙版笔刷参数无效。");
  }
  const output = new Uint8ClampedArray(pixels);
  const mark = selected ? 255 : 0;
  const stamp = (centerX: number, centerY: number) => {
    const left = centerX - Math.floor(brushSize / 2);
    const top = centerY - Math.floor(brushSize / 2);
    for (let by = 0; by < brushSize; by++) {
      for (let bx = 0; bx < brushSize; bx++) {
        if (!square) {
          const nx = ((bx + 0.5) / brushSize) * 2 - 1;
          const ny = ((by + 0.5) / brushSize) * 2 - 1;
          if (nx * nx + ny * ny > 1) continue;
        }
        const x = left + bx;
        const y = top + by;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const offset = (y * width + x) * 4;
        output[offset] = mark;
        output[offset + 1] = mark;
        output[offset + 2] = mark;
        output[offset + 3] = 255;
      }
    }
  };

  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const sx = from.x < to.x ? 1 : -1;
  const dy = -Math.abs(to.y - from.y);
  const sy = from.y < to.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    stamp(x, y);
    if (x === to.x && y === to.y) break;
    const twiceError = 2 * error;
    if (twiceError >= dy) { error += dy; x += sx; }
    if (twiceError <= dx) { error += dx; y += sy; }
  }
  return output;
}

export function maskGridSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("蒙版源图尺寸无效。");
  }
  return {
    width: Math.ceil(width / MASK_GRID_DIVISOR),
    height: Math.ceil(height / MASK_GRID_DIVISOR),
  };
}

/** Convert a downsampled legacy mask to the editor's opaque black/white grid. */
export function normalizeMaskPixels(pixels: Uint8ClampedArray, alphaIsSelection: boolean) {
  if (pixels.length % 4 !== 0) throw new RangeError("蒙版像素数据无效。");
  const normalized = new Uint8ClampedArray(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const coverage = alphaIsSelection
      ? pixels[offset + 3]
      : Math.round(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
    const value = coverage > MASK_THRESHOLD ? 255 : 0;
    normalized[offset] = value;
    normalized[offset + 1] = value;
    normalized[offset + 2] = value;
    normalized[offset + 3] = 255;
  }
  return normalized;
}

/** Expand the low-resolution grid to source dimensions without smoothing. */
export function expandMaskPixels(
  pixels: Uint8ClampedArray,
  gridWidth: number,
  gridHeight: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  const expected = maskGridSize(sourceWidth, sourceHeight);
  if (gridWidth !== expected.width || gridHeight !== expected.height || pixels.length !== gridWidth * gridHeight * 4) {
    throw new RangeError("蒙版网格与源图尺寸不匹配。");
  }
  const expanded = new Uint8ClampedArray(sourceWidth * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y++) {
    const gridY = Math.min(gridHeight - 1, Math.floor(y * gridHeight / sourceHeight));
    for (let x = 0; x < sourceWidth; x++) {
      const gridX = Math.min(gridWidth - 1, Math.floor(x * gridWidth / sourceWidth));
      const from = (gridY * gridWidth + gridX) * 4;
      const to = (y * sourceWidth + x) * 4;
      expanded[to] = pixels[from];
      expanded[to + 1] = pixels[from + 1];
      expanded[to + 2] = pixels[from + 2];
      expanded[to + 3] = 255;
    }
  }
  return expanded;
}

/** Move an opaque binary selection rectangle, leaving cleared cells black. */
export function moveMaskSelectionPixels(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
  deltaX: number,
  deltaY: number,
) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      pixels.length !== width * height * 4 ||
      ![rect.x, rect.y, rect.width, rect.height, deltaX, deltaY].every(Number.isInteger) ||
      rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 ||
      rect.x + rect.width > width || rect.y + rect.height > height ||
      rect.x + deltaX < 0 || rect.y + deltaY < 0 ||
      rect.x + deltaX + rect.width > width || rect.y + deltaY + rect.height > height) {
    throw new RangeError("蒙版选区位置无效。");
  }
  const output = new Uint8ClampedArray(pixels);
  const selected = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const source = ((rect.y + y) * width + rect.x + x) * 4;
      const target = (y * rect.width + x) * 4;
      selected.set(pixels.subarray(source, source + 4), target);
      output.set([0, 0, 0, 255], source);
    }
  }
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const source = (y * rect.width + x) * 4;
      const target = ((rect.y + deltaY + y) * width + rect.x + deltaX + x) * 4;
      output.set(selected.subarray(source, source + 4), target);
    }
  }
  return output;
}

export function hasMaskSelection(pixels: Uint8Array | Uint8ClampedArray) {
  if (pixels.length % 4 !== 0) throw new RangeError("蒙版像素数据无效。");
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > MASK_THRESHOLD && pixels[offset + 3] > 0) return true;
  }
  return false;
}
