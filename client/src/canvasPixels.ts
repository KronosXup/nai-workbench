export type PixelRect = { x: number; y: number; width: number; height: number };

function assertPixels(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(width * height) || pixels.length !== width * height * 4) {
    throw new RangeError("像素数据与画布尺寸不匹配。");
  }
}

/** Returns a 4-connected mask whose pixels are within tolerance of the seed color. */
export function floodFillMask(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance = 24,
): Uint8Array {
  assertPixels(pixels, width, height);
  if (!Number.isInteger(seedX) || !Number.isInteger(seedY) || seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) {
    throw new RangeError("填充起点超出画布范围。");
  }

  const limit = Math.max(0, Math.min(255, Math.floor(tolerance)));
  const pixelCount = width * height;
  if (pixelCount > 0xffffffff) throw new RangeError("填充画布过大。");
  const mask = new Uint8Array(pixelCount);
  let queue = new Uint32Array(Math.min(pixelCount, 1024));
  const seed = seedY * width + seedX;
  const seedOffset = seed * 4;
  const red = pixels[seedOffset];
  const green = pixels[seedOffset + 1];
  const blue = pixels[seedOffset + 2];
  const alpha = pixels[seedOffset + 3];
  let head = 0;
  let tail = 0;
  mask[seed] = 1;
  queue[tail++] = seed;

  const matchesSeed = (index: number) => {
    const offset = index * 4;
    const candidateAlpha = pixels[offset + 3];
    if (alpha === 0 && candidateAlpha === 0) return true;
    return Math.abs(pixels[offset] - red) <= limit &&
      Math.abs(pixels[offset + 1] - green) <= limit &&
      Math.abs(pixels[offset + 2] - blue) <= limit &&
      Math.abs(candidateAlpha - alpha) <= limit;
  };
  const enqueueMatch = (index: number) => {
    if (mask[index] || !matchesSeed(index)) return;
    if (tail === queue.length) {
      const expanded = new Uint32Array(Math.min(pixelCount, queue.length * 2));
      expanded.set(queue);
      queue = expanded;
    }
    mask[index] = 1;
    queue[tail++] = index;
  };

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueueMatch(index - 1);
    if (x + 1 < width) enqueueMatch(index + 1);
    if (y > 0) enqueueMatch(index - width);
    if (y + 1 < height) enqueueMatch(index + width);
  }
  return mask;
}

/** Copies a color into every pixel selected by a flood mask. */
export function colorizeMask(
  pixels: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array,
  color: readonly [number, number, number, number],
): Uint8ClampedArray {
  if (pixels.length % 4 !== 0 || mask.length * 4 !== pixels.length) {
    throw new RangeError("填充区域与像素数据不匹配。");
  }
  const output = new Uint8ClampedArray(pixels);
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const offset = index * 4;
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
    output[offset + 3] = color[3];
  }
  return output;
}

/** Moves a rectangular layer selection, clipping it to the canvas and preserving alpha. */
export function moveLayerSelection(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  rect: PixelRect,
  deltaX: number,
  deltaY: number,
): Uint8ClampedArray {
  assertPixels(pixels, width, height);
  if (![rect.x, rect.y, rect.width, rect.height, deltaX, deltaY].every(Number.isInteger) || rect.width < 1 || rect.height < 1) {
    throw new RangeError("选区位置无效。");
  }

  const output = new Uint8ClampedArray(pixels);
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4;
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
    }
  }

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const destinationX = x + deltaX;
      const destinationY = y + deltaY;
      if (destinationX < 0 || destinationY < 0 || destinationX >= width || destinationY >= height) continue;
      const sourceOffset = (y * width + x) * 4;
      const destinationOffset = (destinationY * width + destinationX) * 4;
      const sourceAlpha = pixels[sourceOffset + 3] / 255;
      if (sourceAlpha === 0) continue;
      if (sourceAlpha === 1 || output[destinationOffset + 3] === 0) {
        output[destinationOffset] = pixels[sourceOffset];
        output[destinationOffset + 1] = pixels[sourceOffset + 1];
        output[destinationOffset + 2] = pixels[sourceOffset + 2];
        output[destinationOffset + 3] = pixels[sourceOffset + 3];
        continue;
      }
      const destinationAlpha = output[destinationOffset + 3] / 255;
      const resultAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel++) {
        output[destinationOffset + channel] = (
          pixels[sourceOffset + channel] * sourceAlpha +
          output[destinationOffset + channel] * destinationAlpha * (1 - sourceAlpha)
        ) / resultAlpha;
      }
      output[destinationOffset + 3] = resultAlpha * 255;
    }
  }
  return output;
}
