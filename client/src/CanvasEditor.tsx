import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Check, Download, Eraser, Eye, EyeOff, Hand, Layers2, Paintbrush, PaintBucket, Pencil, Pipette, Plus, Redo2, Square, Trash2, Undo2, X } from "lucide-react";
import { download as downloadFile, fromBase64, readCanvasProject } from "./storage";
import { MAX_CANVAS_LAYERS, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, validateCanvasProject } from "./canvasProject";
import type { CanvasProject } from "./canvasProject";
import { colorizeMask, floodFillMask, moveLayerSelection } from "./canvasPixels";
import type { PixelRect } from "./canvasPixels";
import "./canvasEditor.css";

const MAX_PIXELS = MAX_CANVAS_PIXELS;
const MAX_SIDE = MAX_CANVAS_SIDE;
const MAX_LAYERS = MAX_CANVAS_LAYERS;
const HISTORY_BYTES = 96 * 1024 * 1024;
const MAX_SOURCE_LENGTH = 32 * 1024 * 1024;

type Layer = { id: number; name: string; visible: boolean; canvas: HTMLCanvasElement };
type PixelAction = { type: "pixels"; id: number; before: ImageData; after: ImageData; bytes: number };
type LayerAction = { type: "layers"; before: Layer[]; after: Layer[]; bytes: number };
type Action = PixelAction | LayerAction;
type BrushShape = "round" | "soft" | "square";
type Stroke = { pointerId: number; layerId: number; before: ImageData; last: { x: number; y: number } | null; erase: boolean; color: string; size: number; shape: BrushShape };
type Pan = { pointerId: number; startX: number; startY: number; x: number; y: number };
type Tool = "brush" | "eraser" | "fill" | "picker" | "select" | "pan";
type SelectionDrag = { pointerId: number; startX: number; startY: number };
type SelectionMove = {
  pointerId: number;
  layerId: number;
  rect: PixelRect;
  anchorX: number;
  anchorY: number;
  before: ImageData;
  content: HTMLCanvasElement;
  preview: HTMLCanvasElement;
  deltaX: number;
  deltaY: number;
};

export type CanvasEditorSave = { data: string; width: number; height: number; project: CanvasProject };
export type CanvasEditorProps = {
  image: string;
  width: number;
  height: number;
  scope: string;
  onSave: (result: CanvasEditorSave) => Promise<void>;
  onCancel: () => void;
};

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function copyLayers(layers: Layer[]): Layer[] {
  return layers.map(layer => ({ ...layer }));
}

function actionSize(action: Action) {
  return action.bytes;
}

function normalizeImage(value: string): string | null {
  if (value.length > MAX_SOURCE_LENGTH) return null;
  if (/^data:image\/(?:png|jpeg|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  if (/^[a-z\d+/=\s]+$/i.test(value)) return `data:image/png;base64,${value}`;
  return null;
}

function sourceBlob(source: string) {
  const matched = /^data:(image\/(?:png|jpeg|webp|avif));base64,/i.exec(source);
  if (!matched) throw new Error("底图格式无效。");
  return fromBase64(source.slice(matched[0].length), matched[1].toLowerCase());
}

function loadBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画布工程图片无法解码。")); };
    img.src = url;
  });
}

function layerBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图层 PNG 导出失败。")), "image/png");
  });
}

function LayerThumbnail({ source, revision }: { source: HTMLCanvasElement | HTMLImageElement | null; revision: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvasRef.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    if (!source) return;
    const sourceWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const sourceHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(source, (target.width - drawWidth) / 2, (target.height - drawHeight) / 2, drawWidth, drawHeight);
  }, [source, revision]);
  return <canvas ref={canvasRef} className="canvas-editor-layer-thumbnail" width={64} height={64} aria-hidden="true" />;
}

export default function CanvasEditor({ image, width, height, scope, onSave, onCancel }: CanvasEditorProps) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const baseBlobRef = useRef<Blob | null>(null);
  const layersRef = useRef<Layer[]>([]);
  const undoRef = useRef<Action[]>([]);
  const redoRef = useRef<Action[]>([]);
  const nextIdRef = useRef(1);
  const strokeRef = useRef<Stroke | null>(null);
  const panRef = useRef<Pan | null>(null);
  const selectionDragRef = useRef<SelectionDrag | null>(null);
  const selectionMoveRef = useRef<SelectionMove | null>(null);
  const selectionRef = useRef<PixelRect | null>(null);
  const selectionDraftRef = useRef<PixelRect | null>(null);
  const spaceRef = useRef(false);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [tool, setTool] = useState<Tool>("brush");
  const [brushShape, setBrushShape] = useState<BrushShape>("round");
  const [color, setColor] = useState("#17162b");
  const [size, setSize] = useState(24);
  const [tolerance, setTolerance] = useState(24);
  const [selection, setSelection] = useState<PixelRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [layersOpen, setLayersOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 760);
  const [renamingLayerId, setRenamingLayerId] = useState<number | null>(null);
  const [layerNameDraft, setLayerNameDraft] = useState("");
  const [error, setError] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);

  const validSize = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  const scale = fit * zoom;

  function changeSelection(next: PixelRect | null) {
    selectionRef.current = next;
    selectionDraftRef.current = null;
    setSelection(next);
  }

  function setSelectionDraft(next: PixelRect | null) {
    selectionDraftRef.current = next;
  }

  function drawComposite(context: CanvasRenderingContext2D) {
    const base = baseRef.current;
    if (!base) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(base, 0, 0);
    const moving = selectionMoveRef.current;
    for (const layer of layersRef.current) {
      if (layer.visible) context.drawImage(moving?.layerId === layer.id ? moving.preview : layer.canvas, 0, 0);
    }
  }

  function drawSelectionOutline(context: CanvasRenderingContext2D) {
    const rect = selectionDraftRef.current ?? selectionRef.current;
    if (!rect) return;
    const line = 1 / Math.max(0.01, scale);
    context.save();
    context.lineWidth = line;
    context.setLineDash([5 * line, 3 * line]);
    context.strokeStyle = "#11101f";
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.lineDashOffset = 4 * line;
    context.strokeStyle = "#f5f3c2";
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }

  function redraw() {
    const preview = previewRef.current;
    const base = baseRef.current;
    if (!preview || !base) return;
    const context = preview.getContext("2d");
    if (!context) return;
    drawComposite(context);
    drawSelectionOutline(context);
  }

  function replaceLayers(next: Layer[]) {
    layersRef.current = next;
    setLayers(next);
    redraw();
  }

  function remember(action: Action) {
    undoRef.current.push(action);
    redoRef.current = [];
    let bytes = undoRef.current.reduce((sum, item) => sum + actionSize(item), 0);
    while (bytes > HISTORY_BYTES && undoRef.current.length > 1) {
      bytes -= actionSize(undoRef.current.shift()!);
    }
    setHistoryVersion(value => value + 1);
  }

  function changeLayers(next: Layer[], memoryCost = 0) {
    remember({ type: "layers", before: copyLayers(layersRef.current), after: copyLayers(next), bytes: memoryCost });
    replaceLayers(next);
  }

  function history(back: boolean) {
    if (strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current || !ready || savingRef.current) return;
    const source = back ? undoRef.current : redoRef.current;
    const target = back ? redoRef.current : undoRef.current;
    const action = source.pop();
    if (!action) return;
    if (action.type === "pixels") {
      const layer = layersRef.current.find(item => item.id === action.id);
      layer?.canvas.getContext("2d")?.putImageData(back ? action.before : action.after, 0, 0);
      redraw();
    } else {
      const next = copyLayers(back ? action.before : action.after);
      replaceLayers(next);
      if (!next.some(layer => layer.id === activeId)) setActiveId(next.at(-1)?.id ?? 0);
    }
    target.push(action);
    setHistoryVersion(value => value + 1);
  }

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError("");
    baseRef.current = null;
    baseBlobRef.current = null;
    layersRef.current = [];
    setLayers([]);
    setRenamingLayerId(null);
    undoRef.current = [];
    redoRef.current = [];
    strokeRef.current = null;
    panRef.current = null;
    selectionDragRef.current = null;
    selectionMoveRef.current = null;
    selectionRef.current = null;
    selectionDraftRef.current = null;
    setSelection(null);
    nextIdRef.current = 1;
    setHistoryVersion(value => value + 1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (!validSize) {
      setError("图片尺寸无效；最长边不能超过 4096 像素，总像素不能超过 419 万。");
      return;
    }
    const source = normalizeImage(image);
    if (!source) {
      setError("仅支持大小不超过 32 MB 的 PNG、JPEG、WebP 或 AVIF 图片数据。");
      return;
    }
    const loaded = new Image();
    loaded.onload = async () => {
      if (cancelled) return;
      if (loaded.naturalWidth !== width || loaded.naturalHeight !== height) {
        setError("图片实际尺寸与传入的宽高不一致。");
        return;
      }
      const preview = previewRef.current;
      if (!preview?.getContext("2d")) {
        setError("浏览器无法创建 2D 画布。");
        return;
      }
      let originalBlob: Blob;
      try { originalBlob = sourceBlob(source); }
      catch { setError("底图数据无法读取。"); return; }
      let base = loaded;
      let baseBlob = originalBlob;
      let restored: Layer[] | undefined;
      let warning = "";
      try {
        // A matching composite PNG may have an editable project bound to this owner and key.
        const project = /^data:image\/png;base64,/i.test(source) ? await readCanvasProject(scope, source) : undefined;
        if (project) {
          if (project.width !== width || project.height !== height) throw new Error("工程尺寸与源图不一致。");
          const images = await Promise.all([loadBlob(project.base), ...project.layers.map(layer => loadBlob(layer.blob))]);
          if (images.some(item => item.naturalWidth !== width || item.naturalHeight !== height))
            throw new Error("工程图层尺寸与源图不一致。");
          base = images[0];
          baseBlob = project.base;
          restored = project.layers.map((item, index) => {
            const canvas = makeCanvas(width, height);
            canvas.getContext("2d")?.drawImage(images[index + 1], 0, 0);
            return { id: item.id, name: item.name, visible: item.visible, canvas };
          });
        }
      } catch (cause) {
        // Keep the source usable, but never pretend its editable layers were restored.
        warning = `${cause instanceof Error ? cause.message : "工程读取失败"} 已按普通图片打开。`;
        base = loaded;
        baseBlob = originalBlob;
        restored = undefined;
      }
      if (cancelled) return;
      preview.width = width;
      preview.height = height;
      baseRef.current = base;
      baseBlobRef.current = baseBlob;
      const next = restored ?? [{ id: 1, name: "图层 1", visible: true, canvas: makeCanvas(width, height) }];
      nextIdRef.current = Math.max(...next.map(item => item.id)) + 1;
      layersRef.current = next;
      setLayers(next);
      setActiveId(next.at(-1)!.id);
      setReady(true);
      setError(warning);
      const context = preview.getContext("2d");
      context?.drawImage(base, 0, 0);
      for (const layer of next) if (layer.visible) context?.drawImage(layer.canvas, 0, 0);
    };
    loaded.onerror = () => { if (!cancelled) setError("图片数据无法解码。"); };
    loaded.src = source;
    return () => { cancelled = true; loaded.src = ""; };
  }, [image, width, height, scope, validSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !validSize) return;
    const update = () => {
      const scale = Math.min((viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height, 1);
      setFit(Math.max(0.01, scale));
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    update();
    return () => observer.disconnect();
  }, [width, height, validSize]);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = previewRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height)),
    };
  }

  function pixelPoint(value: { x: number; y: number }) {
    return { x: Math.max(0, Math.min(width - 1, Math.floor(value.x))), y: Math.max(0, Math.min(height - 1, Math.floor(value.y))) };
  }

  function selectionFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): PixelRect {
    const first = pixelPoint(start);
    const last = pixelPoint(end);
    const x = Math.min(first.x, last.x);
    const y = Math.min(first.y, last.y);
    return { x, y, width: Math.abs(last.x - first.x) + 1, height: Math.abs(last.y - first.y) + 1 };
  }

  function selectionContains(rect: PixelRect, value: { x: number; y: number }) {
    const pixel = pixelPoint(value);
    return pixel.x >= rect.x && pixel.y >= rect.y && pixel.x < rect.x + rect.width && pixel.y < rect.y + rect.height;
  }

  function capturePointer(event: PointerEvent<HTMLCanvasElement>) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      return true;
    } catch {
      setError("无法锁定指针；请重新按住画布操作。");
      return false;
    }
  }

  function compositePixels() {
    const composite = makeCanvas(width, height);
    const context = composite.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法读取合成画布。");
    drawComposite(context);
    return context.getImageData(0, 0, width, height);
  }

  function parseColor(value: string): [number, number, number, number] {
    return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16), 255];
  }

  function samePixels(first: Uint8Array | Uint8ClampedArray, second: Uint8Array | Uint8ClampedArray) {
    if (first.length !== second.length) return false;
    for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return false;
    return true;
  }

  function fillAt(value: { x: number; y: number }) {
    const layer = layersRef.current.find(item => item.id === activeId);
    const context = layer?.canvas.getContext("2d", { willReadFrequently: true });
    if (!layer || !layer.visible || !context) {
      setError("请先选择并显示一个编辑图层；底图已锁定。");
      return;
    }
    try {
      const before = context.getImageData(0, 0, width, height);
      const merged = compositePixels();
      const seed = pixelPoint(value);
      const mask = floodFillMask(merged.data, width, height, seed.x, seed.y, tolerance);
      const after = colorizeMask(before.data, mask, parseColor(color));
      if (samePixels(before.data, after)) return;
      const result = new ImageData(after, width, height);
      context.putImageData(result, 0, 0);
      remember({ type: "pixels", id: layer.id, before, after: result, bytes: before.data.byteLength + result.data.byteLength });
      setError("");
      redraw();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "填充失败，请重试。");
    }
  }

  function pickAt(value: { x: number; y: number }) {
    try {
      const merged = compositePixels();
      const sample = pixelPoint(value);
      const offset = (sample.y * width + sample.x) * 4;
      const hex = [merged.data[offset], merged.data[offset + 1], merged.data[offset + 2]]
        .map(channel => channel.toString(16).padStart(2, "0")).join("");
      setColor(`#${hex}`);
      setError("已从可见合成图取色。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取色失败，请重试。");
    }
  }

  function draw(event: PointerEvent<HTMLCanvasElement>) {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const layer = layersRef.current.find(item => item.id === stroke.layerId);
    const context = layer?.canvas.getContext("2d");
    if (!context) return;
    const current = point(event);
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    if (stroke.shape === "soft") {
      const dab = (x: number, y: number) => {
        const radius = stroke.size / 2;
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, stroke.color);
        gradient.addColorStop(0.45, stroke.color);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      };
      if (!stroke.last) dab(current.x, current.y);
      else {
        const distance = Math.hypot(current.x - stroke.last.x, current.y - stroke.last.y);
        const steps = Math.max(1, Math.ceil(distance / Math.max(1, stroke.size * 0.12)));
        for (let index = 1; index <= steps; index++) {
          const fraction = index / steps;
          dab(stroke.last.x + (current.x - stroke.last.x) * fraction, stroke.last.y + (current.y - stroke.last.y) * fraction);
        }
      }
    } else {
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.size;
      context.lineCap = stroke.shape === "square" ? "square" : "round";
      context.lineJoin = stroke.shape === "square" ? "miter" : "round";
      context.beginPath();
      if (stroke.last) {
        context.moveTo(stroke.last.x, stroke.last.y);
        context.lineTo(current.x, current.y);
        context.stroke();
      } else if (stroke.shape === "square") {
        context.fillRect(current.x - stroke.size / 2, current.y - stroke.size / 2, stroke.size, stroke.size);
      } else {
        context.arc(current.x, current.y, stroke.size / 2, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalCompositeOperation = "source-over";
    stroke.last = current;
    redraw();
  }

  function updateSelectionMove(event: PointerEvent<HTMLCanvasElement>, moving: SelectionMove) {
    const current = pixelPoint(point(event));
    const requestedX = current.x - moving.anchorX;
    const requestedY = current.y - moving.anchorY;
    const deltaX = Math.max(-moving.rect.x, Math.min(width - moving.rect.x - moving.rect.width, requestedX));
    const deltaY = Math.max(-moving.rect.y, Math.min(height - moving.rect.y - moving.rect.height, requestedY));
    if (deltaX === moving.deltaX && deltaY === moving.deltaY) return;
    const layer = layersRef.current.find(item => item.id === moving.layerId);
    const context = layer?.canvas.getContext("2d");
    const previewContext = moving.preview.getContext("2d");
    if (!context || !previewContext || !layer) return;
    previewContext.clearRect(0, 0, width, height);
    previewContext.drawImage(layer.canvas, 0, 0);
    previewContext.clearRect(moving.rect.x, moving.rect.y, moving.rect.width, moving.rect.height);
    previewContext.drawImage(moving.content, moving.rect.x + deltaX, moving.rect.y + deltaY);
    moving.deltaX = deltaX;
    moving.deltaY = deltaY;
    setSelectionDraft({ ...moving.rect, x: moving.rect.x + deltaX, y: moving.rect.y + deltaY });
    redraw();
  }

  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!ready || savingRef.current || event.button !== 0 || strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current) return;
    event.currentTarget.focus({ preventScroll: true });
    if (tool === "pan" || spaceRef.current) {
      event.preventDefault();
      if (!capturePointer(event)) return;
      panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: pan.x, y: pan.y };
      return;
    }
    const current = point(event);
    if (tool === "picker") {
      event.preventDefault();
      pickAt(current);
      return;
    }
    if (tool === "fill") {
      event.preventDefault();
      fillAt(current);
      return;
    }
    if (tool === "select") {
      const selected = selectionRef.current;
      if (selected && selectionContains(selected, current)) {
        const layer = layersRef.current.find(item => item.id === activeId);
        const context = layer?.visible ? layer.canvas.getContext("2d", { willReadFrequently: true }) : null;
        if (!layer || !context) {
          setError("请先选择并显示一个编辑图层；底图已锁定。");
          return;
        }
        try {
          const before = context.getImageData(0, 0, width, height);
          const crop = context.getImageData(selected.x, selected.y, selected.width, selected.height);
          const content = makeCanvas(selected.width, selected.height);
          content.getContext("2d")?.putImageData(crop, 0, 0);
          const preview = makeCanvas(width, height);
          const previewContext = preview.getContext("2d");
          if (!previewContext) throw new Error("无法创建选区预览。");
          previewContext.drawImage(layer.canvas, 0, 0);
          if (!capturePointer(event)) return;
          event.preventDefault();
          selectionMoveRef.current = {
            pointerId: event.pointerId, layerId: layer.id, rect: { ...selected },
            anchorX: pixelPoint(current).x, anchorY: pixelPoint(current).y, before, content, preview, deltaX: 0, deltaY: 0,
          };
          setError("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "无法读取当前图层选区。");
        }
        return;
      }
      if (!capturePointer(event)) return;
      event.preventDefault();
      const start = pixelPoint(current);
      selectionDragRef.current = { pointerId: event.pointerId, startX: start.x, startY: start.y };
      setSelectionDraft({ x: start.x, y: start.y, width: 1, height: 1 });
      redraw();
      return;
    }
    const layer = layersRef.current.find(item => item.id === activeId);
    if (!layer || !layer.visible) {
      setError("请先选择并显示一个编辑图层；底图已锁定。");
      return;
    }
    const before = layer.canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, width, height);
    if (!before) return;
    event.preventDefault();
    if (!capturePointer(event)) return;
    strokeRef.current = { pointerId: event.pointerId, layerId: layer.id, before, last: null, erase: tool === "eraser", color, size, shape: brushShape };
    draw(event);
  }

  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const moving = panRef.current;
    if (moving?.pointerId === event.pointerId) {
      setPan({ x: moving.x + event.clientX - moving.startX, y: moving.y + event.clientY - moving.startY });
      return;
    }
    const selectionMove = selectionMoveRef.current;
    if (selectionMove?.pointerId === event.pointerId) {
      updateSelectionMove(event, selectionMove);
      return;
    }
    const selecting = selectionDragRef.current;
    if (selecting?.pointerId === event.pointerId) {
      setSelectionDraft(selectionFromPoints({ x: selecting.startX, y: selecting.startY }, point(event)));
      redraw();
      return;
    }
    draw(event);
  }

  function pointerEnd(event: PointerEvent<HTMLCanvasElement>, cancelled: boolean) {
    const panning = panRef.current;
    if (panning?.pointerId === event.pointerId) {
      if (cancelled) setPan({ x: panning.x, y: panning.y });
      else setPan({ x: panning.x + event.clientX - panning.startX, y: panning.y + event.clientY - panning.startY });
      panRef.current = null;
      return;
    }
    const stroke = strokeRef.current;
    if (stroke?.pointerId === event.pointerId) {
      const layer = layersRef.current.find(item => item.id === stroke.layerId);
      const context = layer?.canvas.getContext("2d");
      if (cancelled) context?.putImageData(stroke.before, 0, 0);
      else if (context) {
        draw(event);
        const after = context.getImageData(0, 0, width, height);
        if (!samePixels(stroke.before.data, after.data))
          remember({ type: "pixels", id: stroke.layerId, before: stroke.before, after, bytes: stroke.before.data.byteLength + after.data.byteLength });
        setError("");
      }
      strokeRef.current = null;
      redraw();
      return;
    }

    const selecting = selectionDragRef.current;
    if (selecting?.pointerId === event.pointerId) {
      selectionDragRef.current = null;
      if (!cancelled) changeSelection(selectionFromPoints({ x: selecting.startX, y: selecting.startY }, point(event)));
      else setSelectionDraft(null);
      redraw();
      return;
    }

    const moving = selectionMoveRef.current;
    if (moving?.pointerId === event.pointerId) {
      const layer = layersRef.current.find(item => item.id === moving.layerId);
      const context = layer?.canvas.getContext("2d");
      if (!cancelled) {
        updateSelectionMove(event, moving);
        if (context && (moving.deltaX !== 0 || moving.deltaY !== 0)) {
          const data = moveLayerSelection(moving.before.data, width, height, moving.rect, moving.deltaX, moving.deltaY);
          const after = new ImageData(data, width, height);
          if (!samePixels(moving.before.data, after.data)) {
            context.putImageData(after, 0, 0);
            remember({ type: "pixels", id: moving.layerId, before: moving.before, after, bytes: moving.before.data.byteLength + after.data.byteLength });
          }
        }
      }
      selectionMoveRef.current = null;
      const movedRect = cancelled ? moving.rect : { ...moving.rect, x: moving.rect.x + moving.deltaX, y: moving.rect.y + moving.deltaY };
      changeSelection(movedRect);
      setError("");
      redraw();
    }
  }

  function clearActiveLayer() {
    if (!ready || savingRef.current) return;
    if (strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current) {
      setError("请先完成当前画布操作，再清空图层。");
      return;
    }
    const layer = layersRef.current.find(item => item.id === activeId);
    const context = layer?.canvas.getContext("2d", { willReadFrequently: true });
    if (!layer || !context) return;
    try {
      const before = context.getImageData(0, 0, width, height);
      context.clearRect(0, 0, width, height);
      const after = context.getImageData(0, 0, width, height);
      if (samePixels(before.data, after.data)) {
        setError("当前图层已经为空。");
        return;
      }
      remember({ type: "pixels", id: layer.id, before, after, bytes: before.data.byteLength + after.data.byteLength });
      setError("已清空当前图层，可撤销。");
      redraw();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法清空当前图层。");
    }
  }

  function beginRenameLayer(layer: Layer) {
    if (savingRef.current) return;
    setActiveId(layer.id);
    setRenamingLayerId(layer.id);
    setLayerNameDraft(layer.name);
  }

  function commitLayerName(id: number, value: string) {
    setRenamingLayerId(null);
    const name = value.trim();
    const existing = layersRef.current.find(layer => layer.id === id);
    if (!existing || !name) {
      if (existing && !name) setError("图层名称不能为空。");
      return;
    }
    if (existing.name === name) return;
    changeLayers(layersRef.current.map(layer => layer.id === id ? { ...layer, name } : { ...layer }));
    setError("");
  }

  function addLayer() {
    if (!ready || savingRef.current || layers.length >= MAX_LAYERS) return;
    const id = nextIdRef.current++;
    const next = copyLayers(layersRef.current);
    next.push({ id, name: `图层 ${id}`, visible: true, canvas: makeCanvas(width, height) });
    changeLayers(next, width * height * 4);
    setActiveId(id);
  }

  function deleteLayer(id: number) {
    if (savingRef.current || layers.length <= 1) return;
    const removed = layersRef.current.find(layer => layer.id === id);
    const next = layersRef.current.filter(layer => layer.id !== id);
    changeLayers(next, removed ? width * height * 4 : 0);
    if (activeId === id) setActiveId(next.at(-1)!.id);
  }

  function moveLayer(id: number, direction: number) {
    if (savingRef.current) return;
    const index = layersRef.current.findIndex(layer => layer.id === id);
    const other = index + direction;
    if (index < 0 || other < 0 || other >= layers.length) return;
    const next = copyLayers(layersRef.current);
    [next[index], next[other]] = [next[other], next[index]];
    changeLayers(next);
  }

  function toggleLayer(id: number) {
    if (savingRef.current) return;
    changeLayers(layersRef.current.map(layer => layer.id === id ? { ...layer, visible: !layer.visible } : { ...layer }));
  }

  function compositePng() {
    if (!ready || !baseRef.current) throw new Error("画布尚未就绪。");
    const result = makeCanvas(width, height);
    const context = result.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 2D 画布。");
    drawComposite(context);
    const data = result.toDataURL("image/png").split(",")[1];
    if (data.length > 20 * 1024 * 1024) throw new Error("合成图超过 20 MB，请缩小画布后再保存。");
    return data;
  }

  async function save() {
    if (!ready || !baseBlobRef.current || savingRef.current || strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const data = compositePng();
      const project: CanvasProject = {
        version: 1, width, height, base: baseBlobRef.current,
        layers: await Promise.all(layersRef.current.map(async layer => ({
          id: layer.id, name: layer.name, visible: layer.visible, blob: await layerBlob(layer.canvas),
        }))),
      };
      validateCanvasProject(project);
      await onSave({ data, width, height, project });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存画布工程失败，请重试。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function downloadPng() {
    if (!ready || savingRef.current || strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current) return;
    try {
      downloadFile(fromBase64(compositePng(), "image/png"), `canvas-${width}x${height}.png`);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "下载 PNG 失败，请重试。");
    }
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (savingRef.current) return;
      const hadPointerAction = Boolean(strokeRef.current || panRef.current || selectionDragRef.current || selectionMoveRef.current);
      if (strokeRef.current) {
        const stroke = strokeRef.current;
        layersRef.current.find(layer => layer.id === stroke.layerId)?.canvas.getContext("2d")?.putImageData(stroke.before, 0, 0);
        strokeRef.current = null;
      }
      if (panRef.current) {
        setPan({ x: panRef.current.x, y: panRef.current.y });
        panRef.current = null;
      }
      if (selectionMoveRef.current) {
        selectionMoveRef.current = null;
      }
      selectionDragRef.current = null;
      setSelectionDraft(null);
      spaceRef.current = false;
      if (hadPointerAction || selectionRef.current || tool === "select") {
        changeSelection(null);
        if (tool === "select") setTool("brush");
        redraw();
      } else onCancel();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    if (savingRef.current) return;
    if (event.code === "Space" && !event.repeat) { spaceRef.current = true; event.preventDefault(); return; }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "z") { event.preventDefault(); history(!event.shiftKey); }
      else if (event.key.toLowerCase() === "y") { event.preventDefault(); history(false); }
      return;
    }
    if (event.key.toLowerCase() === "b") setTool("brush");
    else if (event.key.toLowerCase() === "e") setTool("eraser");
    else if (event.key.toLowerCase() === "g") setTool("fill");
    else if (event.key.toLowerCase() === "i") setTool("picker");
    else if (event.key.toLowerCase() === "m") setTool("select");
    else if (event.key.toLowerCase() === "h") setTool("pan");
  }

  const statusText = error || (saving ? "正在保存可编辑工程…" : selection ? `选区 ${selection.width} × ${selection.height} px；按 Esc 清除选区。` : "");

  return <section className="canvas-editor" role="dialog" aria-modal="true" aria-label="2D 画布编辑器"
    onKeyDown={keyDown} onKeyUp={event => { if (event.code === "Space") spaceRef.current = false; }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) spaceRef.current = false; }}>
    <div className="canvas-editor-viewport" ref={viewportRef}>
      <canvas ref={previewRef} tabIndex={0} role="img" aria-label="编辑画布；填充按可见合成图识别，选区在当前图层移动，按空格拖动画布"
        width={validSize ? width : 1} height={validSize ? height : 1}
        style={{ width: width * scale, height: height * scale, transform: `translate(${pan.x}px, ${pan.y}px)`, cursor: tool === "pan" ? "grab" : tool === "select" && selection ? "move" : tool === "picker" ? "copy" : tool === "fill" ? "cell" : "crosshair" }}
        onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={event => pointerEnd(event, false)} onPointerCancel={event => pointerEnd(event, true)}
        onLostPointerCapture={event => pointerEnd(event, true)} />
      {!ready && <div className="canvas-editor-placeholder">{error || "正在载入图片…"}</div>}
    </div>

    <div className="canvas-editor-topbar">
      <div className="canvas-editor-settings" aria-label="工具设置">
        <div className="canvas-editor-draw-label"><Paintbrush size={17} /><span>绘制</span></div>
        <div className="canvas-editor-color-control">
          <input type="color" disabled={saving} aria-label="画笔与填充颜色" value={color} onChange={event => setColor(event.target.value)} />
          <button type="button" disabled={saving} aria-label="颜色面板吸管" title="从可见合成图取色（I）" aria-pressed={tool === "picker"} onClick={() => setTool("picker")}><Pipette size={17} /></button>
        </div>
        {tool === "fill" ? <label className="canvas-editor-range">
          <span>容差 {tolerance}</span><input type="range" disabled={saving} aria-label="填充颜色容差" min="0" max="128" value={tolerance} onChange={event => setTolerance(Number(event.target.value))} />
        </label> : <label className="canvas-editor-range">
          <span>笔刷 {size}px</span><input type="range" disabled={saving} aria-label="笔刷大小" min="1" max="200" value={size} onChange={event => setSize(Number(event.target.value))} />
        </label>}
        {(tool === "brush" || tool === "eraser") && <div className="canvas-editor-brush-shapes" role="group" aria-label="笔刷形状">
          <button type="button" disabled={saving} aria-label="硬边圆刷" title="硬边圆刷" aria-pressed={brushShape === "round"} onClick={() => setBrushShape("round")}><span className="canvas-editor-brush-sample canvas-editor-brush-round" /></button>
          <button type="button" disabled={saving} aria-label="柔边圆刷" title="柔边圆刷" aria-pressed={brushShape === "soft"} onClick={() => setBrushShape("soft")}><span className="canvas-editor-brush-sample canvas-editor-brush-soft" /></button>
          <button type="button" disabled={saving} aria-label="方形画笔" title="方形画笔" aria-pressed={brushShape === "square"} onClick={() => setBrushShape("square")}><span className="canvas-editor-brush-sample canvas-editor-brush-square" /></button>
        </div>}
      </div>

      <div className="canvas-editor-actions" aria-label="保存与导出">
        <button type="button" disabled={!ready || saving} aria-label="下载 PNG" title="下载 PNG" onClick={downloadPng}><Download size={18} /></button>
        <button type="button" className="canvas-editor-save" aria-label="保存并关闭" title="保存并关闭" disabled={!ready || saving} onClick={() => void save()}><Check size={16} /><span className="canvas-editor-save-long">保存并关闭</span><span className="canvas-editor-save-short">保存</span></button>
        <button type="button" onClick={onCancel} disabled={saving} aria-label="关闭画布编辑器" title="关闭"><X size={18} /></button>
      </div>
    </div>

    <nav className="canvas-editor-toolstrip" aria-label="画布工具">
      <div className="canvas-editor-toolstrip-tools">
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "brush"} title="画笔（B）" aria-label="画笔" onClick={() => setTool("brush")}><Paintbrush size={18} /></button>
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "eraser"} title="橡皮（E）" aria-label="橡皮" onClick={() => setTool("eraser")}><Eraser size={18} /></button>
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "fill"} title="区域填充（G）" aria-label="填充" onClick={() => setTool("fill")}><PaintBucket size={18} /></button>
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "select"} title="矩形选区（M）" aria-label="矩形选区" onClick={() => setTool("select")}><Square size={18} /></button>
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "picker"} title="从可见合成图取色（I）" aria-label="吸管工具" onClick={() => setTool("picker")}><Pipette size={18} /></button>
        <button type="button" disabled={!ready || saving} aria-pressed={tool === "pan"} title="抓手（H）" aria-label="抓手" onClick={() => setTool("pan")}><Hand size={18} /></button>
      </div>
      <span className="canvas-editor-toolstrip-divider" aria-hidden="true" />
      <div className="canvas-editor-toolstrip-actions">
        <button type="button" disabled={!ready || saving} title="清空当前图层（可撤销）" aria-label="清空当前图层" onClick={clearActiveLayer}><Trash2 size={18} /></button>
        <button type="button" aria-label="撤销" title="撤销 Ctrl+Z" disabled={!ready || saving || !undoRef.current.length} onClick={() => history(true)}><Undo2 size={18} /></button>
        <button type="button" aria-label="重做" title="重做 Ctrl+Y" disabled={!ready || saving || !redoRef.current.length} onClick={() => history(false)}><Redo2 size={18} /></button>
      </div>
    </nav>

    <div className="canvas-editor-zoom" aria-label="画布缩放">
      <button type="button" aria-label="缩小" title="缩小" onClick={() => setZoom(value => Math.max(0.25, value / 1.25))}>−</button>
      <button type="button" className="canvas-editor-zoom-fit" title="适应画布" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(scale * 100)}%</button>
      <button type="button" aria-label="放大" title="放大" onClick={() => setZoom(value => Math.min(8, value * 1.25))}>＋</button>
    </div>

    {layersOpen && <aside id="canvas-editor-layers-panel" className="canvas-editor-layer-panel" aria-label="图层面板">
      <div className="canvas-editor-layers-heading">
        <span>图层</span>
        <button type="button" onClick={addLayer} disabled={!ready || saving || layers.length >= MAX_LAYERS} title={`添加图层（最多 ${MAX_LAYERS} 层）`} aria-label="添加图层"><Plus size={17} /></button>
        <button type="button" onClick={() => setLayersOpen(false)} aria-label="收起图层面板" title="收起图层面板"><X size={15} /></button>
      </div>
      <ul className="canvas-editor-layer-list">
        {[...layers].reverse().map((layer, reverseIndex) => {
          const index = layers.length - 1 - reverseIndex;
          return <li key={layer.id} className={`canvas-editor-layer${activeId === layer.id ? " selected" : ""}${layer.visible ? "" : " hidden-layer"}`}>
            <button type="button" className="canvas-editor-layer-select" aria-pressed={activeId === layer.id} aria-label={`选择${layer.name}`} disabled={saving} onClick={() => setActiveId(layer.id)}>
              <LayerThumbnail source={layer.canvas} revision={historyVersion} />
            </button>
            <div className="canvas-editor-layer-details">
              {renamingLayerId === layer.id ? <input autoFocus maxLength={80} aria-label="图层名称" value={layerNameDraft}
                onChange={event => setLayerNameDraft(event.target.value)} onBlur={event => commitLayerName(layer.id, event.currentTarget.value)}
                onKeyDown={event => {
                  if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.value = layer.name; event.currentTarget.blur(); }
                }} /> : <button type="button" className="canvas-editor-layer-name" title={layer.name} aria-pressed={activeId === layer.id} disabled={saving} onClick={() => setActiveId(layer.id)}>{layer.name}</button>}
              <div className="canvas-editor-layer-actions">
                <button type="button" aria-label={`重命名${layer.name}`} title="重命名" disabled={saving} onClick={() => beginRenameLayer(layer)}><Pencil size={14} /></button>
                <button type="button" aria-label={`${layer.visible ? "隐藏" : "显示"}${layer.name}`} title={layer.visible ? "隐藏图层" : "显示图层"} disabled={saving} onClick={() => toggleLayer(layer.id)}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                <button type="button" aria-label={`上移${layer.name}`} title="上移" disabled={saving || index === layers.length - 1} onClick={() => moveLayer(layer.id, 1)}>↑</button>
                <button type="button" aria-label={`下移${layer.name}`} title="下移" disabled={saving || index === 0} onClick={() => moveLayer(layer.id, -1)}>↓</button>
                <button type="button" aria-label={`删除${layer.name}`} title="删除图层" disabled={saving || layers.length <= 1} onClick={() => deleteLayer(layer.id)}><Trash2 size={14} /></button>
              </div>
            </div>
          </li>;
        })}
        <li className="canvas-editor-layer canvas-editor-base">
          <LayerThumbnail source={baseRef.current} revision={historyVersion} />
          <span>底图 <small>只读</small></span>
        </li>
      </ul>
      <p>底图已锁定。修改只写入可编辑图层。</p>
    </aside>}

    <button type="button" className="canvas-editor-layers-toggle" aria-controls="canvas-editor-layers-panel" aria-expanded={layersOpen}
      aria-label={`${layersOpen ? "收起" : "展开"}图层面板，${layers.length} 个编辑图层`} title="图层"
      onClick={() => setLayersOpen(value => !value)}><Layers2 size={18} /><span>{layers.length}</span></button>
    <div className="canvas-editor-status" role="status" aria-live="polite" hidden={!statusText}>{statusText}</div>
  </section>;
}
