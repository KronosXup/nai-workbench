import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { clampCanvasCamera, fitCanvasRect, zoomCanvasAt } from './outputCanvasGeometry';
import type { CanvasCamera, CanvasRect, CanvasSize } from './outputCanvasGeometry';

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pan'; id: number; start: Point; camera: CanvasCamera }
  | { kind: 'pinch'; ids: [number, number]; center: Point; distance: number; camera: CanvasCamera };
type Props = {
  viewportRef: RefObject<HTMLDivElement | null>;
  worldRef: RefObject<HTMLDivElement | null>;
  onTap?: (point: Point, camera: CanvasCamera) => void;
  onSettled?: (camera: CanvasCamera, viewport: CanvasSize) => void;
  allowUpscale?: boolean;
  bounds: CanvasRect;
};

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

export default function useOutputCamera({ viewportRef, worldRef, onTap, onSettled, bounds, allowUpscale = true }: Props) {
  const [camera, setCamera] = useState<CanvasCamera>({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = useState<CanvasSize>({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const current = useRef(camera), size = useRef(viewport);
  const target = useRef<CanvasRect | undefined>(undefined);
  const manual = useRef(false), reducedMotion = useRef(false);
  const animation = useRef<number | undefined>(undefined);
  const publishFrame = useRef<number | undefined>(undefined);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | undefined>(undefined);
  const wasDrag = useRef(false), tap = useRef(onTap);
  const settled = useRef(onSettled), settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const upscale = useRef(allowUpscale);
  const limits = useRef(bounds);
  limits.current = bounds;
  tap.current = onTap;
  settled.current = onSettled;
  upscale.current = allowUpscale;

  const cancelAnimation = useCallback(() => {
    if (animation.current !== undefined) cancelAnimationFrame(animation.current);
    animation.current = undefined;
  }, []);

  const clearSettled = useCallback(() => {
    if (settleTimer.current !== undefined) clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
  }, []);
  const scheduleSettled = useCallback(() => {
    clearSettled();
    settleTimer.current = setTimeout(() => {
      settleTimer.current = undefined;
      settled.current?.(current.current, size.current);
    }, 160);
  }, [clearSettled]);
  const retarget = useCallback((rect: CanvasRect) => { target.current = rect; }, []);

  const apply = useCallback((next: CanvasCamera, publishNow = false) => {
    next = clampCanvasCamera(next, size.current, limits.current);
    current.current = next;
    if (worldRef.current) worldRef.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    if (publishNow) {
      if (publishFrame.current !== undefined) cancelAnimationFrame(publishFrame.current);
      publishFrame.current = undefined;
      setCamera(next);
    } else if (publishFrame.current === undefined) {
      publishFrame.current = requestAnimationFrame(() => {
        publishFrame.current = undefined;
        setCamera(current.current);
      });
    }
  }, [worldRef]);

  useLayoutEffect(() => { apply(current.current, true); }, [bounds.x, bounds.y, bounds.width, bounds.height, apply]);

  const clearPointers = useCallback(() => {
    const ids = [...pointers.current.keys()];
    pointers.current.clear();
    gesture.current = undefined;
    setDragging(false);
    const element = viewportRef.current;
    for (const id of ids) if (element?.hasPointerCapture(id)) element.releasePointerCapture(id);
  }, [viewportRef]);

  const fit = useCallback((rect: CanvasRect, animated = true) => {
    clearSettled();
    cancelAnimation();
    clearPointers();
    target.current = rect;
    manual.current = false;
    if (size.current.width <= 0 || size.current.height <= 0) return;
    const next = fitCanvasRect(rect, size.current, 24, upscale.current);
    if (!animated || reducedMotion.current) { apply(next, true); return; }
    const start = current.current, startedAt = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - startedAt) / 420);
      const eased = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      apply({
        x: start.x + (next.x - start.x) * eased,
        y: start.y + (next.y - start.y) * eased,
        scale: start.scale + (next.scale - start.scale) * eased,
      }, true);
      animation.current = t < 1 ? requestAnimationFrame(frame) : undefined;
    };
    animation.current = requestAnimationFrame(frame);
  }, [apply, cancelAnimation, clearPointers, clearSettled]);

  useLayoutEffect(() => {
    if (target.current) fit(target.current);
  }, [allowUpscale, fit]);

  const zoomAt = useCallback((point: Point, scale: number) => {
    cancelAnimation();
    clearPointers();
    manual.current = true;
    apply(zoomCanvasAt(current.current, point, scale));
    scheduleSettled();
  }, [apply, cancelAnimation, clearPointers, scheduleSettled]);

  const panBy = useCallback((dx: number, dy: number) => {
    cancelAnimation();
    clearPointers();
    manual.current = true;
    apply({ ...current.current, x: current.current.x + dx, y: current.current.y + dy });
    scheduleSettled();
  }, [apply, cancelAnimation, clearPointers, scheduleSettled]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      reducedMotion.current = motion.matches;
      if (motion.matches && animation.current !== undefined) {
        cancelAnimation();
        if (target.current) apply(fitCanvasRect(target.current, size.current, 24, upscale.current), true);
      }
    };
    updateMotion();
    motion.addEventListener('change', updateMotion);
    const resize = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      if (!next.width || !next.height || (next.width === size.current.width && next.height === size.current.height)) return;
      const previous = size.current;
      size.current = next;
      setViewport(next);
      cancelAnimation();
      clearPointers();
      if (!manual.current && target.current) apply(fitCanvasRect(target.current, next, 24, upscale.current), true);
      else if (previous.width && previous.height) {
        apply({ ...current.current,
          x: current.current.x + (next.width - previous.width) / 2,
          y: current.current.y + (next.height - previous.height) / 2,
        }, true);
      } else apply(current.current, true);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = { x: event.clientX - rect.left - element.clientLeft, y: event.clientY - rect.top - element.clientTop };
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.current.height : 1;
      if (event.ctrlKey) zoomAt(point, current.current.scale * Math.exp(-event.deltaY * unit * .002));
      else panBy(-(event.deltaX + (event.shiftKey ? event.deltaY : 0)) * unit, -(event.shiftKey ? 0 : event.deltaY) * unit);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    element.addEventListener('wheel', wheel, { passive: false });
    resize();
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      motion.removeEventListener('change', updateMotion);
      cancelAnimation();
      if (publishFrame.current !== undefined) cancelAnimationFrame(publishFrame.current);
      publishFrame.current = undefined;
      clearPointers();
      clearSettled();
    };
  }, [apply, cancelAnimation, clearPointers, clearSettled, viewportRef, zoomAt, panBy]);

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left - event.currentTarget.clientLeft, y: event.clientY - rect.top - event.currentTarget.clientTop };
  };
  const restartGesture = () => {
    const entries = [...pointers.current.entries()];
    if (entries.length === 1) gesture.current = { kind: 'pan', id: entries[0][0], start: entries[0][1], camera: current.current };
    else if (entries.length === 2) {
      gesture.current = { kind: 'pinch', ids: [entries[0][0], entries[1][0]],
        center: midpoint(entries[0][1], entries[1][1]), distance: Math.max(1, distance(entries[0][1], entries[1][1])), camera: current.current };
      wasDrag.current = true;
      manual.current = true;
      setDragging(true);
    } else gesture.current = undefined;
  };
  const updateGesture = () => {
    const active = gesture.current;
    if (!active) return;
    if (active.kind === 'pan') {
      const point = pointers.current.get(active.id);
      if (!point || (!wasDrag.current && distance(point, active.start) < 4)) return;
      wasDrag.current = true;
      manual.current = true;
      setDragging(true);
      apply({ ...active.camera, x: active.camera.x + point.x - active.start.x, y: active.camera.y + point.y - active.start.y });
    } else {
      const a = pointers.current.get(active.ids[0]), b = pointers.current.get(active.ids[1]);
      if (!a || !b) return;
      const center = midpoint(a, b);
      const next = zoomCanvasAt(active.camera, active.center, active.camera.scale * distance(a, b) / active.distance);
      apply({ ...next, x: next.x + center.x - active.center.x, y: next.y + center.y - active.center.y });
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return;
    if (pointers.current.has(event.pointerId) || pointers.current.size >= 2) return;
    clearSettled();
    cancelAnimation();
    if (!pointers.current.size) wasDrag.current = false;
    if (event.button === 1) event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, localPoint(event));
    restartGesture();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, localPoint(event));
    updateGesture();
  };
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    if (!cancelled) {
      pointers.current.set(event.pointerId, point);
      updateGesture();
    }
    const isTap = !cancelled && pointers.current.size === 1 && !wasDrag.current && event.button !== 1;
    pointers.current.delete(event.pointerId);
    restartGesture();
    if (!pointers.current.size) {
      setDragging(false);
      if (wasDrag.current) scheduleSettled();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (isTap) tap.current?.(point, current.current);
  };

  return { camera, viewport, fit, retarget, zoomAt, panBy, dragging, wasDrag, handlers: {
    onPointerDown, onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, true),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finishPointer(event, true),
  } };
}
