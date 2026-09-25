/**
 * CPU implementation of the Pixel Snap core. It has no DOM or Canvas
 * dependencies so callers can run it in a Worker or in a Node test.
 */
export type PaletteMode = "off" | "auto" | "custom";

export type PixelSnapOptions = {
  /** 0 asks the detector; a positive value is an explicit grid-pitch override. */
  cellSize: number;
  avoidOverRefining: boolean;
  paletteMode: PaletteMode;
  paletteSize: number;
  upscale: boolean;
};

export type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type PixelSnapResult = PixelBuffer & {
  gridWidth: number;
  gridHeight: number;
  pitch: number;
  paletteSize: number;
  confident: boolean;
  scale: number;
};

const MAX_SIDE = 4096;
const MAX_PIXELS = 4_194_304;
const MAX_PALETTE = 256;
const AUTO_PALETTE_ERROR = 6.5;
const HISTOGRAM_SIZE = 32 * 32 * 32;

type AxisEvidence = {
  pitch: number;
  phase: number;
  score: number;
  support: number;
  contrast: number;
};

type AxisProfile = {
  raw: Float64Array;
  feature: Float64Array;
  maxFeature: number;
  noiseFloor: number;
  minimumLineStrength: number;
  evidence: AxisEvidence | null;
};

type Grid = {
  width: number;
  height: number;
  pitch: number;
  data: Uint8ClampedArray;
  xBounds: number[];
  yBounds: number[];
  error: number;
};

type PalettePoint = { r: number; g: number; b: number; count: number };
type ColorBox = {
  points: number[];
  count: number;
  mean: [number, number, number];
  ranges: [number, number, number];
  error: number;
  maxErrorSquared: number;
};

function validate(source: PixelBuffer, options: PixelSnapOptions): void {
  if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
      source.width < 1 || source.height < 1 || source.width > MAX_SIDE || source.height > MAX_SIDE) {
    throw new RangeError(`图片尺寸必须在 1 到 ${MAX_SIDE} 像素之间。`);
  }
  const pixelCount = source.width * source.height;
  if (pixelCount > MAX_PIXELS) {
    throw new RangeError(`图片像素数不能超过 ${MAX_PIXELS.toLocaleString("en-US")}。`);
  }
  if (!(source.data instanceof Uint8ClampedArray) || source.data.length !== pixelCount * 4) {
    throw new TypeError("像素数据必须是与宽高匹配的 RGBA Uint8ClampedArray。");
  }
  if (!options || !Number.isFinite(options.cellSize) || options.cellSize < 0 || options.cellSize > MAX_SIDE) {
    throw new RangeError(`网格尺寸必须为 0 到 ${MAX_SIDE} 之间的有限数值。`);
  }
  if (options.paletteMode !== "off" && options.paletteMode !== "auto" && options.paletteMode !== "custom") {
    throw new TypeError("未知的调色板模式。");
  }
  if (!Number.isInteger(options.paletteSize) || options.paletteSize < 1 || options.paletteSize > MAX_PALETTE) {
    throw new RangeError(`调色板颜色数必须为 1 到 ${MAX_PALETTE}。`);
  }
  if (typeof options.avoidOverRefining !== "boolean" || typeof options.upscale !== "boolean") {
    throw new TypeError("avoidOverRefining 和 upscale 必须是布尔值。");
  }
}

/** Compare visible colors in premultiplied RGBA space, so hidden RGB is ignored. */
function edgeDistance(data: Uint8ClampedArray, a: number, b: number): number {
  const alphaA = data[a + 3] / 255;
  const alphaB = data[b + 3] / 255;
  if (alphaA < 0.03 && alphaB < 0.03) return 0;
  const red = data[a] * alphaA - data[b] * alphaB;
  const green = data[a + 1] * alphaA - data[b + 1] * alphaB;
  const blue = data[a + 2] * alphaA - data[b + 2] * alphaB;
  const alpha = data[a + 3] - data[b + 3];
  return Math.sqrt(0.30 * red * red + 0.59 * green * green + 0.11 * blue * blue + 0.25 * alpha * alpha);
}

/** Sum adjacent-pixel contrast into one profile per image axis. */
function buildEdgeProfiles(source: PixelBuffer): { x: Float64Array; y: Float64Array } {
  const { width, height, data } = source;
  const x = new Float64Array(width);
  const y = new Float64Array(height);
  for (let row = 0; row < height; row++) {
    const rowOffset = row * width * 4;
    for (let column = 1; column < width; column++) {
      x[column] += edgeDistance(data, rowOffset + (column - 1) * 4, rowOffset + column * 4);
    }
  }
  for (let row = 1; row < height; row++) {
    const upperOffset = (row - 1) * width * 4;
    const lowerOffset = row * width * 4;
    for (let column = 0; column < width; column++) {
      const at = column * 4;
      y[row] += edgeDistance(data, upperOffset + at, lowerOffset + at);
    }
  }
  return { x, y };
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor((values.length - 1) / 2)];
}

function profilePhase(profile: AxisProfile, pitch: number): { phase: number; score: number; support: number } {
  const length = profile.raw.length;
  const supportThreshold = Math.max(profile.minimumLineStrength, profile.maxFeature * 0.10);
  const jitter = pitch >= 4 ? 1 : 0;
  let total = 0;
  for (let position = 1; position < length; position++) {
    total += profile.feature[position];
  }
  let bestPhase = 0;
  let bestEnergy = -1;
  let bestPhaseCost = Infinity;
  let bestSupport = 0;
  for (let phase = 0; phase < pitch; phase++) {
    let energy = 0;
    let phaseCost = 0;
    let support = 0;
    const firstBoundary = phase === 0 ? pitch : phase;
    for (let center = firstBoundary; center < length; center += pitch) {
      // Ignore clipped search windows at the image ends; their missing side
      // would make an unrelated interior edge look like a lattice hit.
      if (center - jitter < 1 || center + jitter >= length) continue;
      let strongest = 0;
      let offset = 0;
      for (let position = Math.max(1, center - jitter); position <= Math.min(length - 1, center + jitter); position++) {
        const strength = profile.feature[position];
        if (strength > strongest || (strength === strongest && Math.abs(position - center) < Math.abs(offset))) {
          strongest = strength;
          offset = position - center;
        }
      }
      energy += strongest;
      phaseCost += strongest * offset * offset;
      if (strongest >= supportThreshold) support++;
    }
    if (energy > bestEnergy ||
        (energy === bestEnergy && phaseCost < bestPhaseCost) ||
        (energy === bestEnergy && phaseCost === bestPhaseCost && support > bestSupport)) {
      bestPhase = phase;
      bestEnergy = energy;
      bestPhaseCost = phaseCost;
      bestSupport = support;
    }
  }
  return { phase: bestPhase, score: total > 0 ? bestEnergy / total : 0, support: bestSupport };
}

function analyzeAxis(raw: Float64Array, orthogonalLength: number): AxisProfile {
  const profile: AxisProfile = {
    raw,
    feature: new Float64Array(raw.length),
    maxFeature: 0,
    noiseFloor: 0,
    minimumLineStrength: Math.max(1, orthogonalLength * 0.75),
    evidence: null,
  };
  const profileValues: number[] = [];
  for (let position = 1; position < raw.length; position++) profileValues.push(raw[position]);
  if (profileValues.every(value => value === 0)) return profile;

  // Removing the common background prevents smooth gradients and photo noise
  // from looking like a repeated pixel lattice.
  profile.noiseFloor = medianNumber(profileValues) * 1.35;
  for (let position = 1; position < raw.length; position++) {
    const feature = Math.max(0, raw[position] - profile.noiseFloor);
    profile.feature[position] = feature;
    profile.maxFeature = Math.max(profile.maxFeature, feature);
  }
  if (profile.maxFeature < profile.minimumLineStrength) return profile;

  let totalFeature = 0;
  for (let position = 1; position < raw.length; position++) totalFeature += profile.feature[position];
  if (totalFeature <= 0) return profile;

  const maxPitch = Math.min(64, Math.floor((raw.length - 1) / 3));
  for (let pitch = 2; pitch <= maxPitch; pitch++) {
    const candidate = profilePhase(profile, pitch);
    const jitter = pitch >= 4 ? 1 : 0;
    const randomAlignment = (2 * jitter + 1) / pitch;
    const threshold = pitch === 2 ? 0.78 : pitch === 3 ? 0.72 : Math.max(0.80, randomAlignment + 0.20);
    if (candidate.support < 3 || candidate.score < threshold) continue;
    // A larger candidate is preferred once it explains a coherent set of
    // repeated boundaries. This recovers the coarsest useful grid first.
    profile.evidence = {
      pitch,
      phase: candidate.phase,
      score: candidate.score,
      support: candidate.support,
      contrast: totalFeature / Math.max(1, raw.length - 1),
    };
  }
  return profile;
}

function phaseAtPitch(profile: AxisProfile, pitch: number): number {
  if (profile.maxFeature < profile.minimumLineStrength) return 0;
  return profilePhase(profile, pitch).phase;
}

function choosePitch(x: AxisProfile, y: AxisProfile): AxisEvidence | null {
  const horizontal = x.evidence;
  const vertical = y.evidence;
  if (!horizontal) return vertical;
  if (!vertical) return horizontal;
  if (horizontal.pitch === vertical.pitch) {
    return {
      ...horizontal,
      phase: horizontal.phase,
      score: Math.min(horizontal.score, vertical.score),
      support: horizontal.support + vertical.support,
    };
  }

  const quality = (evidence: AxisEvidence, profileLength: number) => {
    const expectedLines = Math.max(1, profileLength / evidence.pitch);
    const coverage = Math.min(1, evidence.support / Math.max(3, expectedLines * 0.45));
    return evidence.score * (0.55 + 0.45 * coverage) * Math.sqrt(Math.max(1, evidence.support));
  };
  const xQuality = quality(horizontal, x.raw.length);
  const yQuality = quality(vertical, y.raw.length);
  if (Math.abs(xQuality - yQuality) > 0.12 * Math.max(xQuality, yQuality)) {
    return xQuality > yQuality ? horizontal : vertical;
  }
  // When both axes carry comparable evidence, use the coarser estimate; an
  // image can be slightly cropped or have irregular rows and columns.
  return horizontal.pitch >= vertical.pitch ? horizontal : vertical;
}

function makeBoundaries(
  length: number,
  pitch: number,
  phase: number,
  profile: AxisProfile,
  adaptToEdges: boolean,
): number[] {
  const bounds = [0];
  const normalizedPhase = ((phase % pitch) + pitch) % pitch;
  const first = normalizedPhase === 0 ? pitch : normalizedPhase;
  const radius = pitch >= 2.5 ? Math.min(3, Math.max(1, Math.round(pitch * 0.20))) : 0;
  const minimumGap = Math.max(1, Math.floor(pitch * 0.52));
  const snapThreshold = Math.max(profile.minimumLineStrength, profile.maxFeature * 0.10);
  let accumulatedShift = 0;
  const maximumShift = Math.max(1, Math.ceil(pitch * 0.60));
  const maxSteps = Math.ceil(length / pitch) + 2;

  for (let step = 0; step < maxSteps; step++) {
    const idealPosition = first + step * pitch + accumulatedShift;
    const predicted = Math.round(idealPosition);
    if (predicted >= length) break;
    let boundary = predicted;
    if (adaptToEdges && radius > 0 && profile.maxFeature >= snapThreshold) {
      const low = Math.max(bounds.length === 1 ? 1 : bounds[bounds.length - 1] + minimumGap, Math.ceil(idealPosition - radius));
      const high = Math.min(length - minimumGap, Math.floor(idealPosition + radius));
      let strongest = 0;
      for (let position = low; position <= high; position++) {
        if (profile.feature[position] > strongest) {
          strongest = profile.feature[position];
          boundary = position;
        }
      }
      if (strongest < snapThreshold) boundary = predicted;
    }
    if (boundary > bounds[bounds.length - 1] && boundary < length) {
      bounds.push(boundary);
      if (adaptToEdges && boundary !== predicted) {
        accumulatedShift = Math.max(-maximumShift, Math.min(maximumShift, accumulatedShift + boundary - predicted));
      }
    }
  }
  bounds.push(length);
  return bounds;
}

function selectKth(values: Uint8Array, length: number, wanted: number): number {
  let left = 0;
  let right = length - 1;
  while (left < right) {
    const pivot = values[(left + right) >>> 1];
    let low = left;
    let high = right;
    while (low <= high) {
      while (values[low] < pivot) low++;
      while (values[high] > pivot) high--;
      if (low <= high) {
        const swap = values[low];
        values[low] = values[high];
        values[high] = swap;
        low++;
        high--;
      }
    }
    if (wanted <= high) right = high;
    else if (wanted >= low) left = low;
    else return values[wanted];
  }
  return values[left];
}

function smallMedian(values: Uint8Array, count: number): number {
  const middle = Math.floor((count - 1) / 2);
  const lower = selectKth(values, count, middle);
  if (count % 2 === 1) return lower;
  const upper = selectKth(values, count, middle + 1);
  return (lower + upper) / 2;
}

function histogramMedian(histogram: Uint32Array, count: number): number {
  const lowerRank = Math.floor((count - 1) / 2);
  const upperRank = Math.floor(count / 2);
  let seen = 0;
  let lower = 0;
  let upper = 0;
  for (let value = 0; value < histogram.length; value++) {
    const next = seen + histogram[value];
    if (seen <= lowerRank && lowerRank < next) lower = value;
    if (seen <= upperRank && upperRank < next) {
      upper = value;
      break;
    }
    seen = next;
  }
  return (lower + upper) / 2;
}

function interior(start: number, end: number, pitch: number): [number, number] {
  const size = end - start;
  if (size < 3 || size < pitch * 0.65) return [start, end];
  const trim = Math.min(Math.max(1, Math.round(pitch * 0.12)), Math.floor((size - 1) / 2));
  return [start + trim, end - trim];
}

function sampleGrid(source: PixelBuffer, xBounds: number[], yBounds: number[], pitch: number): Grid {
  const gridWidth = xBounds.length - 1;
  const gridHeight = yBounds.length - 1;
  const output = new Uint8ClampedArray(gridWidth * gridHeight * 4);
  const scratch = Array.from({ length: 7 }, () => new Uint8Array(4096));
  const histograms = Array.from({ length: 7 }, () => new Uint32Array(256));
  const { width, data } = source;

  for (let gridY = 0; gridY < gridHeight; gridY++) {
    const [outerTop, outerBottom] = [yBounds[gridY], yBounds[gridY + 1]];
    const [top, bottom] = interior(outerTop, outerBottom, pitch);
    for (let gridX = 0; gridX < gridWidth; gridX++) {
      const [outerLeft, outerRight] = [xBounds[gridX], xBounds[gridX + 1]];
      const [left, right] = interior(outerLeft, outerRight, pitch);
      const sampleCount = (right - left) * (bottom - top);
      let visibleCount = 0;
      let index = 0;
      let alphaCount = 0;
      if (sampleCount <= 4096) {
        for (let row = top; row < bottom; row++) {
          for (let column = left; column < right; column++) {
            const at = (row * width + column) * 4;
            const red = data[at];
            const green = data[at + 1];
            const blue = data[at + 2];
            const alpha = data[at + 3];
            scratch[0][index] = red;
            scratch[1][index] = green;
            scratch[2][index] = blue;
            scratch[3][index] = alpha;
            if (alpha >= 8) {
              scratch[4][visibleCount] = red;
              scratch[5][visibleCount] = green;
              scratch[6][visibleCount] = blue;
              visibleCount++;
            }
            index++;
          }
        }
        alphaCount = index;
      } else {
        for (const histogram of histograms) histogram.fill(0);
        for (let row = top; row < bottom; row++) {
          for (let column = left; column < right; column++) {
            const at = (row * width + column) * 4;
            const red = data[at];
            const green = data[at + 1];
            const blue = data[at + 2];
            const alpha = data[at + 3];
            histograms[0][red]++;
            histograms[1][green]++;
            histograms[2][blue]++;
            histograms[3][alpha]++;
            if (alpha >= 8) {
              histograms[4][red]++;
              histograms[5][green]++;
              histograms[6][blue]++;
              visibleCount++;
            }
            alphaCount++;
          }
        }
      }

      const target = (gridY * gridWidth + gridX) * 4;
      if (sampleCount <= 4096) {
        output[target] = smallMedian(scratch[visibleCount ? 4 : 0], visibleCount || alphaCount);
        output[target + 1] = smallMedian(scratch[visibleCount ? 5 : 1], visibleCount || alphaCount);
        output[target + 2] = smallMedian(scratch[visibleCount ? 6 : 2], visibleCount || alphaCount);
        output[target + 3] = smallMedian(scratch[3], alphaCount);
      } else {
        output[target] = histogramMedian(histograms[visibleCount ? 4 : 0], visibleCount || alphaCount);
        output[target + 1] = histogramMedian(histograms[visibleCount ? 5 : 1], visibleCount || alphaCount);
        output[target + 2] = histogramMedian(histograms[visibleCount ? 6 : 2], visibleCount || alphaCount);
        output[target + 3] = histogramMedian(histograms[3], alphaCount);
      }
    }
  }
  return { width: gridWidth, height: gridHeight, pitch, data: output, xBounds, yBounds, error: 0 };
}

function pixelError(source: Uint8ClampedArray, sourceAt: number, representative: Uint8ClampedArray, repAt: number): number {
  const sourceAlpha = source[sourceAt + 3] / 255;
  const repAlpha = representative[repAt + 3] / 255;
  const red = source[sourceAt] * sourceAlpha - representative[repAt] * repAlpha;
  const green = source[sourceAt + 1] * sourceAlpha - representative[repAt + 1] * repAlpha;
  const blue = source[sourceAt + 2] * sourceAlpha - representative[repAt + 2] * repAlpha;
  const alpha = source[sourceAt + 3] - representative[repAt + 3];
  return Math.sqrt(0.30 * red * red + 0.59 * green * green + 0.11 * blue * blue + 0.25 * alpha * alpha);
}

function reconstructionError(source: PixelBuffer, grid: Grid): number {
  let total = 0;
  const { width, data } = source;
  for (let gridY = 0; gridY < grid.height; gridY++) {
    const top = grid.yBounds[gridY];
    const bottom = grid.yBounds[gridY + 1];
    for (let gridX = 0; gridX < grid.width; gridX++) {
      const left = grid.xBounds[gridX];
      const right = grid.xBounds[gridX + 1];
      const repAt = (gridY * grid.width + gridX) * 4;
      for (let row = top; row < bottom; row++) {
        for (let column = left; column < right; column++) {
          total += pixelError(data, (row * width + column) * 4, grid.data, repAt);
        }
      }
    }
  }
  return total / (source.width * source.height);
}

function weightedDistanceSquared(a: PalettePoint, b: PalettePoint): number {
  const red = a.r - b.r;
  const green = a.g - b.g;
  const blue = a.b - b.b;
  return 0.30 * red * red + 0.59 * green * green + 0.11 * blue * blue;
}

function makeColorBox(points: PalettePoint[], indices: number[]): ColorBox {
  let count = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let lowR = 255, lowG = 255, lowB = 255;
  let highR = 0, highG = 0, highB = 0;
  for (const index of indices) {
    const point = points[index];
    count += point.count;
    red += point.r * point.count;
    green += point.g * point.count;
    blue += point.b * point.count;
    lowR = Math.min(lowR, point.r); lowG = Math.min(lowG, point.g); lowB = Math.min(lowB, point.b);
    highR = Math.max(highR, point.r); highG = Math.max(highG, point.g); highB = Math.max(highB, point.b);
  }
  const mean: [number, number, number] = [red / count, green / count, blue / count];
  const center: PalettePoint = { r: mean[0], g: mean[1], b: mean[2], count: 1 };
  let error = 0;
  let maxErrorSquared = 0;
  for (const index of indices) {
    const distance = weightedDistanceSquared(points[index], center);
    error += points[index].count * distance;
    maxErrorSquared = Math.max(maxErrorSquared, distance);
  }
  return {
    points: indices,
    count,
    mean,
    ranges: [highR - lowR, highG - lowG, highB - lowB],
    error,
    maxErrorSquared,
  };
}

function makeHistogram(data: Uint8ClampedArray): PalettePoint[] {
  const counts = new Uint32Array(HISTOGRAM_SIZE);
  const redSums = new Uint32Array(HISTOGRAM_SIZE);
  const greenSums = new Uint32Array(HISTOGRAM_SIZE);
  const blueSums = new Uint32Array(HISTOGRAM_SIZE);
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] < 8) continue;
    const red = data[at];
    const green = data[at + 1];
    const blue = data[at + 2];
    const key = (red >> 3) << 10 | (green >> 3) << 5 | (blue >> 3);
    counts[key]++;
    redSums[key] += red;
    greenSums[key] += green;
    blueSums[key] += blue;
  }
  const points: PalettePoint[] = [];
  for (let key = 0; key < HISTOGRAM_SIZE; key++) {
    const count = counts[key];
    if (!count) continue;
    points.push({
      r: redSums[key] / count,
      g: greenSums[key] / count,
      b: blueSums[key] / count,
      count,
    });
  }
  return points;
}

/**
 * Build a bounded median-cut palette. Auto mode stops when weighted RGB RMS
 * error is within tolerance; custom mode stops at the requested color count.
 */
function buildPalette(data: Uint8ClampedArray, limit: number, auto: boolean): [number, number, number][] {
  const points = makeHistogram(data);
  if (points.length === 0) return [];
  const indices = Array.from({ length: points.length }, (_, index) => index);
  const boxes = [makeColorBox(points, indices)];

  const paletteFromBoxes = () => boxes.map(box => [
    Math.round(box.mean[0]), Math.round(box.mean[1]), Math.round(box.mean[2]),
  ] as [number, number, number]);
  // A weighted mean can discard a rare but important accent color. Auto mode
  // therefore keeps splitting until every occupied color bin is within the
  // perceptual tolerance, even when that bin contributes little total weight.
  const maxErrorSquared = AUTO_PALETTE_ERROR * AUTO_PALETTE_ERROR;
  const withinAutoError = () => boxes.every(box => box.maxErrorSquared <= maxErrorSquared);

  while (boxes.length < limit && (!auto || !withinAutoError())) {
    let splitIndex = -1;
    let splitScore = -1;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (box.points.length < 2) continue;
      const spread = Math.max(box.ranges[0] * 0.55, box.ranges[1] * 0.85, box.ranges[2] * 0.35);
      const score = box.error > 0 ? (auto ? box.maxErrorSquared : spread * Math.sqrt(box.count)) : 0;
      if (score > splitScore) { splitScore = score; splitIndex = index; }
    }
    if (splitIndex < 0 || splitScore <= 0) break;

    const box = boxes[splitIndex];
    const weightedRanges = [box.ranges[0] * 0.55, box.ranges[1] * 0.85, box.ranges[2] * 0.35];
    const axis = weightedRanges.indexOf(Math.max(...weightedRanges));
    const channel = axis === 0 ? "r" : axis === 1 ? "g" : "b";
    box.points.sort((a, b) => points[a][channel] - points[b][channel]);
    let running = 0;
    let splitAt = 1;
    for (let position = 0; position < box.points.length - 1; position++) {
      running += points[box.points[position]].count;
      splitAt = position + 1;
      if (running >= box.count / 2) break;
    }
    const left = makeColorBox(points, box.points.slice(0, splitAt));
    const right = makeColorBox(points, box.points.slice(splitAt));
    boxes.splice(splitIndex, 1, left, right);
  }
  return paletteFromBoxes();
}

function paletteIndex(r: number, g: number, b: number): number {
  return (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
}

function applyPalette(data: Uint8ClampedArray, palette: [number, number, number][]): void {
  if (palette.length === 0) return;
  const nearest = new Int16Array(HISTOGRAM_SIZE);
  nearest.fill(-1);
  for (let key = 0; key < HISTOGRAM_SIZE; key++) {
    const red = ((key >> 10) & 31) * 8 + 3.5;
    const green = ((key >> 5) & 31) * 8 + 3.5;
    const blue = (key & 31) * 8 + 3.5;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < palette.length; index++) {
      const candidate = palette[index];
      const dr = red - candidate[0];
      const dg = green - candidate[1];
      const db = blue - candidate[2];
      const distance = 0.30 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    }
    nearest[key] = bestIndex;
  }
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] < 8) continue;
    const candidate = palette[nearest[paletteIndex(data[at], data[at + 1], data[at + 2])]];
    data[at] = candidate[0];
    data[at + 1] = candidate[1];
    data[at + 2] = candidate[2];
  }
}

function chooseScale(source: PixelBuffer, gridWidth: number, gridHeight: number, upscale: boolean): number {
  if (!upscale) return 1;
  const maximum = Math.min(
    Math.floor(MAX_SIDE / gridWidth),
    Math.floor(MAX_SIDE / gridHeight),
    Math.floor(Math.sqrt(MAX_PIXELS / (gridWidth * gridHeight))),
  );
  let selected = 1;
  let bestCost = Infinity;
  for (let scale = 1; scale <= maximum; scale++) {
    const widthCost = Math.abs(gridWidth * scale - source.width) / source.width;
    const heightCost = Math.abs(gridHeight * scale - source.height) / source.height;
    const cost = widthCost + heightCost;
    if (cost < bestCost) { selected = scale; bestCost = cost; }
  }
  return selected;
}

function upscaleNearest(source: PixelBuffer, scale: number): PixelBuffer {
  if (scale === 1) return { width: source.width, height: source.height, data: source.data };
  const width = source.width * scale;
  const height = source.height * scale;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new RangeError("放大后的图片超出允许的输出尺寸。");
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < source.height; y++) {
    const sourceRow = y * source.width * 4;
    for (let repeatY = 0; repeatY < scale; repeatY++) {
      const targetRow = (y * scale + repeatY) * width * 4;
      for (let x = 0; x < source.width; x++) {
        const sourceAt = sourceRow + x * 4;
        const red = source.data[sourceAt];
        const green = source.data[sourceAt + 1];
        const blue = source.data[sourceAt + 2];
        const alpha = source.data[sourceAt + 3];
        for (let repeatX = 0; repeatX < scale; repeatX++) {
          const targetAt = targetRow + (x * scale + repeatX) * 4;
          data[targetAt] = red;
          data[targetAt + 1] = green;
          data[targetAt + 2] = blue;
          data[targetAt + 3] = alpha;
        }
      }
    }
  }
  return { width, height, data };
}

function cloneBuffer(source: PixelBuffer): PixelBuffer {
  return { width: source.width, height: source.height, data: source.data.slice() };
}

/**
 * Recover a repeated grid and replace each cell with an interior median color.
 * Alpha is summarized independently, and hidden RGB is ignored when a cell has
 * visible samples; this avoids dark fringes around transparent artwork.
 */
export function snapPixels(source: PixelBuffer, options: PixelSnapOptions): PixelSnapResult {
  validate(source, options);
  const edgeProfiles = buildEdgeProfiles(source);
  const xProfile = analyzeAxis(edgeProfiles.x, source.height);
  const yProfile = analyzeAxis(edgeProfiles.y, source.width);
  const manualPitch = options.cellSize > 0;
  const detected = manualPitch ? null : choosePitch(xProfile, yProfile);
  const pitch = manualPitch ? Math.max(1, Math.round(options.cellSize)) : (detected?.pitch ?? 1);
  const confident = !manualPitch && detected !== null;

  // A blank, flat, or weakly structured image carries no grid evidence. Keep
  // its original sampling instead of imposing an arbitrary tiny lattice.
  if (!manualPitch && !detected) {
    let gridBuffer = cloneBuffer(source);
    let paletteSize = 0;
    if (options.paletteMode !== "off") {
      const palette = buildPalette(gridBuffer.data, options.paletteMode === "custom" ? options.paletteSize : MAX_PALETTE,
        options.paletteMode === "auto");
      applyPalette(gridBuffer.data, palette);
      paletteSize = palette.length;
    }
    const scale = chooseScale(source, gridBuffer.width, gridBuffer.height, options.upscale);
    const output = upscaleNearest(gridBuffer, scale);
    return { ...output, gridWidth: gridBuffer.width, gridHeight: gridBuffer.height, pitch: 1, paletteSize, confident: false, scale };
  }

  // Estimate phase independently for each axis: the pitch may come from the
  // stronger axis, whose origin need not match the weaker axis's crop.
  const xPhase = phaseAtPitch(xProfile, pitch);
  const yPhase = phaseAtPitch(yProfile, pitch);
  const xCanAdapt = xProfile.evidence?.pitch === pitch;
  const yCanAdapt = yProfile.evidence?.pitch === pitch;

  const makeGrid = (gridPitch: number, phaseX: number, phaseY: number, adaptX: boolean, adaptY: boolean) => {
    const xBounds = makeBoundaries(source.width, gridPitch, phaseX, xProfile, adaptX);
    const yBounds = makeBoundaries(source.height, gridPitch, phaseY, yProfile, adaptY);
    if (gridPitch === 1) {
      return {
        width: source.width,
        height: source.height,
        pitch: gridPitch,
        data: source.data.slice(),
        xBounds,
        yBounds,
        error: 0,
      };
    }
    return sampleGrid(source, xBounds, yBounds, gridPitch);
  };

  let bestGrid = makeGrid(pitch, xPhase, yPhase, xCanAdapt, yCanAdapt);
  let bestPitch = pitch;
  if (!manualPitch && !options.avoidOverRefining && pitch > 1) {
    bestGrid.error = reconstructionError(source, bestGrid);
    const finePitches = [...new Set([pitch / 2, pitch / 3])]
      .filter(candidate => candidate >= 1.5 && candidate < pitch);
    for (const finePitch of finePitches) {
      const phaseX = xPhase % finePitch;
      const phaseY = yPhase % finePitch;
      const candidate = makeGrid(
        finePitch,
        phaseX,
        phaseY,
        xProfile.evidence?.pitch === finePitch,
        yProfile.evidence?.pitch === finePitch,
      );
      candidate.error = reconstructionError(source, candidate);
      const improvement = bestGrid.error - candidate.error;
      // Refinement must reduce actual source reconstruction error enough to
      // justify the additional cells; equal-error finer grids stay coarse.
      if (improvement > Math.max(0.5, bestGrid.error * 0.20)) {
        bestGrid = candidate;
        bestPitch = finePitch;
      }
    }
  }

  let paletteSize = 0;
  if (options.paletteMode !== "off") {
    const palette = buildPalette(bestGrid.data, options.paletteMode === "custom" ? options.paletteSize : MAX_PALETTE,
      options.paletteMode === "auto");
    applyPalette(bestGrid.data, palette);
    paletteSize = palette.length;
  }

  const small: PixelBuffer = { width: bestGrid.width, height: bestGrid.height, data: bestGrid.data };
  const scale = chooseScale(source, small.width, small.height, options.upscale);
  const output = upscaleNearest(small, scale);
  return {
    ...output,
    gridWidth: bestGrid.width,
    gridHeight: bestGrid.height,
    pitch: bestGrid.width === source.width && bestGrid.height === source.height ? 1 : bestPitch,
    paletteSize,
    confident,
    scale,
  };
}
