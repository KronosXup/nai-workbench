export type CanvasRect = { x: number; y: number; width: number; height: number };
export type CanvasCamera = { x: number; y: number; scale: number };
export type CanvasSize = { width: number; height: number };
export type CanvasItem = { id: string; width: number; height: number };
export type CanvasPlacement = CanvasRect & { id: string };

// The oldest image anchors the timeline, so prepending new results keeps old positions.
export function layoutCanvasItems(items: readonly CanvasItem[], gap = 220): CanvasPlacement[] {
  const placements: CanvasPlacement[] = new Array(items.length);
  let y = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (index < items.length - 1) y -= item.height + gap;
    placements[index] = { id: item.id, x: -item.width / 2, y, width: item.width, height: item.height };
  }
  return placements;
}

export function fitCanvasRect(rect: CanvasRect, viewport: CanvasSize, padding = 24, allowUpscale = false): CanvasCamera {
  const scale = Math.max(.02, Math.min(allowUpscale ? 8 : 1,
    (viewport.width - padding * 2) / rect.width,
    (viewport.height - padding * 2) / rect.height));
  return {
    x: viewport.width / 2 - (rect.x + rect.width / 2) * scale,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * scale,
    scale,
  };
}

export function zoomCanvasAt(camera: CanvasCamera, point: { x: number; y: number }, newScale: number): CanvasCamera {
  const scale = Math.max(.02, Math.min(8, newScale));
  const ratio = scale / camera.scale;
  return {
    x: point.x - (point.x - camera.x) * ratio,
    y: point.y - (point.y - camera.y) * ratio,
    scale,
  };
}

export function canvasVisibleRect(camera: CanvasCamera, viewport: CanvasSize): CanvasRect {
  return {
    x: -camera.x / camera.scale,
    y: -camera.y / camera.scale,
    width: viewport.width / camera.scale,
    height: viewport.height / camera.scale,
  };
}

export function clampCanvasCamera(camera: CanvasCamera, viewport: CanvasSize, bounds: CanvasRect, padding = 24): CanvasCamera {
  if (!viewport.width || !viewport.height) return camera;
  const axis = (position: number, start: number, length: number, available: number) =>
    length * camera.scale <= available - padding * 2
      ? available / 2 - (start + length / 2) * camera.scale
      : Math.max(available - padding - (start + length) * camera.scale,
          Math.min(padding - start * camera.scale, position));
  return { ...camera, x: axis(camera.x, bounds.x, bounds.width, viewport.width),
    y: axis(camera.y, bounds.y, bounds.height, viewport.height) };
}

export function canvasRectsIntersect(a: CanvasRect, b: CanvasRect, margin = 0): boolean {
  return a.x <= b.x + b.width + margin && a.x + a.width >= b.x - margin
    && a.y <= b.y + b.height + margin && a.y + a.height >= b.y - margin;
}
