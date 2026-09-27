import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, WheelEvent } from "react";
import {
  Check,
  ChevronDown,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  PaintBucket,
  Paintbrush,
  Redo2,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { expandMaskPixels, hasMaskSelection, maskBrushGridWidth, maskGridSize, moveMaskSelectionPixels, normalizeMaskPixels, paintMaskGridStroke } from "./maskGrid";
import { colorizeMask, floodFillMask, moveLayerSelection, type PixelRect } from "./canvasPixels";
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, type CanvasProject, validateCanvasProject } from "./canvasProject";
import { readCanvasProject } from "./storage";
import "./maskEditor.css";

const MASK_LAYER_ID = 0;
const MAX_DRAW_LAYERS = 6;
const HISTORY_BYTES = 96 * 1024 * 1024;
const PALETTE = ["#f74c6f", "#f5b342", "#e9e56a", "#62d6a8", "#58b7f1", "#9b83f7", "#f5f5fb", "#202237"];
type DrawLayer = { id: number; name: string; visible: boolean; canvas: HTMLCanvasElement };
type LayerSnapshot = { layers: DrawLayer[]; maskVisible: boolean };
type PixelAction = { type: "pixels"; id: number; before: ImageData; after: ImageData; bytes: number };
type LayerAction = { type: "layers"; before: LayerSnapshot; after: LayerSnapshot; bytes: number };
type Action = PixelAction | LayerAction;
type Point = { x: number; y: number };
type Stroke = { pointerId: number; layerId: number; before: ImageData; last: Point | null; erase: boolean };
type Pan = { pointerId: number; startX: number; startY: number; x: number; y: number };
type SelectionDrag = { pointerId: number; start: Point };
type SelectionMove = { pointerId: number; layerId: number; rect: PixelRect; anchor: Point; before: ImageData; dx: number; dy: number };

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function copyLayerSnapshot(snapshot: LayerSnapshot): LayerSnapshot {
  return { layers: snapshot.layers.map(layer => ({ ...layer })), maskVisible: snapshot.maskVisible };
}

function pixelsDiffer(before: Uint8Array | Uint8ClampedArray, after: Uint8Array | Uint8ClampedArray) {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return true;
  return false;
}

function colorTuple(value: string): [number, number, number, number] {
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16), 255];
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图层工程图片读取失败。"));
    reader.onerror = () => reject(new Error("图层工程图片读取失败。"));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const result = new Image();
    result.onload = () => resolve(result);
    result.onerror = () => reject(new Error("图层工程图片无法解码。"));
    result.src = src;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图层 PNG 导出失败。")), "image/png"));
}

export default function MaskEditor({
  image,
  initial,
  scope,
  onClose,
  onSave,
}: {
  image: string;
  initial?: string;
  scope: string;
  onClose: () => void;
  onSave: (maskBase64: string, editedSourceBase64?: string, project?: CanvasProject) => Promise<void>;
}) {
  const maskCanvas = useRef<HTMLCanvasElement>(null);
  const paintComposite = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const imageWrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const sourceImage = useRef<HTMLImageElement | null>(null);
  const naturalSize = useRef<{ width: number; height: number } | null>(null);
  const sourceBase = useRef<Blob | null>(null);
  const projectLoaded = useRef(false);
  const layersRef = useRef<DrawLayer[]>([]);
  const maskVisibleRef = useRef(true);
  const undo = useRef<Action[]>([]);
  const redo = useRef<Action[]>([]);
  const historyBytes = useRef(0);
  const nextLayerId = useRef(1);
  const readyRef = useRef(false);
  const stroke = useRef<Stroke | null>(null);
  const pan = useRef<Pan | null>(null);
  const selectionDrag = useRef<SelectionDrag | null>(null);
  const selectionMove = useRef<SelectionMove | null>(null);
  const selectionRef = useRef<PixelRect | null>(null);
  const selectionDraftRef = useRef<PixelRect | null>(null);
  const spaceDown = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [, refreshHistory] = useState(0);
  const [layers, setLayers] = useState<DrawLayer[]>([]);
  const [layersOpen, setLayersOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 700);
  const [maskVisible, setMaskVisible] = useState(true);
  const [activeId, setActiveId] = useState(MASK_LAYER_ID);
  const [tool, setTool] = useState<"brush" | "eraser" | "fill" | "select" | "pan">("brush");
  const [size, setSize] = useState(4);
  const [color, setColor] = useState(PALETTE[0]);
  const [maskTint, setMaskTint] = useState(PALETTE[0]);
  const [squareBrush, setSquareBrush] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [selection, setSelection] = useState<PixelRect | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<PixelRect | null>(null);
  const [sourceUrl, setSourceUrl] = useState(`data:image/png;base64,${image}`);
  const maskTintRef = useRef(maskTint);
  maskTintRef.current = maskTint;
  const historyRef = useRef<(back: boolean) => void>(() => {});
  const redrawRef = useRef<() => void>(() => {});
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const savingRef = useRef(false);

  const activeIsMask = activeId === MASK_LAYER_ID;
  const ordinaryLayersSupported = Boolean(naturalSize.current && naturalSize.current.width <= MAX_CANVAS_SIDE &&
    naturalSize.current.height <= MAX_CANVAS_SIDE && naturalSize.current.width * naturalSize.current.height <= MAX_CANVAS_PIXELS);

  const snapshotLayers = (): LayerSnapshot => ({ layers: layersRef.current.map(layer => ({ ...layer })), maskVisible: maskVisibleRef.current });

  const redrawPaint = useCallback(() => {
    const output = paintComposite.current;
    const size = naturalSize.current;
    if (!output || !size) return;
    if (output.width !== size.width) output.width = size.width;
    if (output.height !== size.height) output.height = size.height;
    const context = output.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    for (const layer of layersRef.current) if (layer.visible) context.drawImage(layer.canvas, 0, 0);
  }, []);

  const redrawOverlay = useCallback(() => {
    const mask = maskCanvas.current;
    const overlay = overlayCanvas.current;
    if (!readyRef.current || !mask || !overlay) return;
    if (overlay.width !== mask.width) overlay.width = mask.width;
    if (overlay.height !== mask.height) overlay.height = mask.height;
    const context = overlay.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);
    if (!maskVisibleRef.current) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(mask, 0, 0);
    const pixels = context.getImageData(0, 0, overlay.width, overlay.height);
    const [red, green, blue] = colorTuple(maskTintRef.current);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const coverage = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / (3 * 255);
      pixels.data[i] = red;
      pixels.data[i + 1] = green;
      pixels.data[i + 2] = blue;
      pixels.data[i + 3] = Math.round(coverage * 0.46 * 255);
    }
    context.putImageData(pixels, 0, 0);
  }, []);

  const redraw = useCallback(() => { redrawPaint(); redrawOverlay(); }, [redrawPaint, redrawOverlay]);
  redrawRef.current = redraw;

  useEffect(() => { redrawOverlay(); }, [maskTint, redrawOverlay]);

  const fitImageToStage = useCallback(() => {
    const sourceSize = naturalSize.current;
    const area = stage.current;
    if (!sourceSize || !area) return;
    const bounds = area.getBoundingClientRect();
    const style = window.getComputedStyle(area);
    const availableWidth = bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = bounds.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const scale = Math.min(availableWidth / sourceSize.width, availableHeight / sourceSize.height);
    const next = { width: Math.max(1, Math.round(sourceSize.width * scale)), height: Math.max(1, Math.round(sourceSize.height * scale)) };
    setDisplaySize(current => current?.width === next.width && current.height === next.height ? current : next);
  }, []);

  useEffect(() => {
    const wrapper = imageWrap.current;
    const area = stage.current;
    if (!wrapper || !area) return;
    const wrapperObserver = new ResizeObserver(redraw);
    wrapperObserver.observe(wrapper);
    const stageObserver = new ResizeObserver(fitImageToStage);
    stageObserver.observe(area);
    return () => { wrapperObserver.disconnect(); stageObserver.disconnect(); };
  }, [fitImageToStage, redraw]);

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    setReady(false);
    setSaveError("");
    undo.current = [];
    redo.current = [];
    historyBytes.current = 0;
    savingRef.current = false;
    setSaving(false);
    sourceBase.current = null;
    projectLoaded.current = false;
    setSourceUrl(`data:image/png;base64,${image}`);
    layersRef.current = [];
    setLayers([]);
    maskVisibleRef.current = true;
    setMaskVisible(true);
    setActiveId(MASK_LAYER_ID);
    selectionRef.current = null;
    selectionDraftRef.current = null;
    setSelection(null);
    setSelectionPreview(null);
    nextLayerId.current = 1;
    const source = new Image();
    source.onload = async () => {
      if (cancelled) return;
      const mask = maskCanvas.current;
      const displayPaint = paintComposite.current;
      if (!mask || !displayPaint) return;
      naturalSize.current = { width: source.naturalWidth, height: source.naturalHeight };
      let base = source;
      let nextSourceUrl = `data:image/png;base64,${image}`;
      try {
        const project = await readCanvasProject(scope, `data:image/png;base64,${image}`);
        if (project) {
          if (project.width !== source.naturalWidth || project.height !== source.naturalHeight) throw new Error("图层工程尺寸与源图不同。");
          const baseUrl = await blobDataUrl(project.base);
          const projectBase = await loadImage(baseUrl);
          if (projectBase.naturalWidth !== project.width || projectBase.naturalHeight !== project.height) throw new Error("图层工程底图尺寸无效。");
          const restored: DrawLayer[] = await Promise.all(project.layers.map(async item => {
            const blobUrl = await blobDataUrl(item.blob);
            const layerImage = await loadImage(blobUrl);
            if (layerImage.naturalWidth !== project.width || layerImage.naturalHeight !== project.height) throw new Error("图层尺寸与源图不一致。");
            const canvas = makeCanvas(project.width, project.height);
            canvas.getContext("2d")?.drawImage(layerImage, 0, 0);
            return { id: item.id, name: item.name, visible: item.visible, canvas };
          }));
          if (cancelled) return;
          base = projectBase;
          sourceBase.current = project.base;
          projectLoaded.current = true;
          layersRef.current = restored;
          setLayers(restored);
          nextLayerId.current = Math.max(...restored.map(layer => layer.id), 0) + 1;
          nextSourceUrl = baseUrl;
        }
      } catch (error) {
        if (cancelled) return;
        base = source;
        sourceBase.current = null;
        projectLoaded.current = false;
        layersRef.current = [];
        setLayers([]);
        nextLayerId.current = 1;
        nextSourceUrl = `data:image/png;base64,${image}`;
        setSaveError(`${error instanceof Error ? error.message : "图层工程读取失败。"} 已按合成图片打开。`);
      }
      if (cancelled) return;
      sourceImage.current = base;
      setSourceUrl(nextSourceUrl);
      const grid = maskGridSize(source.naturalWidth, source.naturalHeight);
      mask.width = grid.width;
      mask.height = grid.height;
      displayPaint.width = source.naturalWidth;
      displayPaint.height = source.naturalHeight;
      const context = mask.getContext("2d");
      if (!context) { setSaveError("浏览器无法创建蒙版画布。"); return; }
      context.fillStyle = "#000";
      context.fillRect(0, 0, mask.width, mask.height);
      requestAnimationFrame(fitImageToStage);
      const readyNow = () => {
        if (cancelled) return;
        readyRef.current = true;
        setReady(true);
        requestAnimationFrame(redrawRef.current);
      };
      if (!initial) { readyNow(); return; }
      const savedMask = new Image();
      savedMask.onload = () => {
        if (cancelled) return;
        if (savedMask.naturalWidth !== source.naturalWidth || savedMask.naturalHeight !== source.naturalHeight) {
          setSaveError("已有蒙版尺寸与源图不同；请关闭后重新载入，避免覆盖原蒙版。");
          return;
        }
        const low = makeCanvas(mask.width, mask.height);
        const lowContext = low.getContext("2d", { willReadFrequently: true });
        if (!lowContext) { setSaveError("无法读取已有蒙版；请关闭后重新上传，避免覆盖原蒙版。"); return; }
        lowContext.imageSmoothingEnabled = true;
        lowContext.imageSmoothingQuality = "high";
        lowContext.drawImage(savedMask, 0, 0, low.width, low.height);
        const loaded = lowContext.getImageData(0, 0, low.width, low.height);
        const hasAlphaSelection = loaded.data.some((_, index) => index % 4 === 3 && loaded.data[index] !== 255);
        context.putImageData(new ImageData(normalizeMaskPixels(loaded.data, hasAlphaSelection), low.width, low.height), 0, 0);
        readyNow();
      };
      savedMask.onerror = () => { if (!cancelled) setSaveError("已有蒙版图片无法读取；请关闭后重新上传，避免覆盖原蒙版。"); };
      savedMask.src = `data:image/png;base64,${initial}`;
    };
    source.onerror = () => { if (!cancelled) setSaveError("源图无法读取，蒙版编辑器未能载入。"); };
    source.src = `data:image/png;base64,${image}`;
    return () => { cancelled = true; };
  }, [image, initial, scope, fitImageToStage]);

  const activeCanvas = () => activeId === MASK_LAYER_ID
    ? maskCanvas.current
    : layersRef.current.find(layer => layer.id === activeId)?.canvas ?? null;

  const record = (action: Action) => {
    historyBytes.current -= redo.current.reduce((sum, item) => sum + item.bytes, 0);
    redo.current = [];
    undo.current.push(action);
    historyBytes.current += action.bytes;
    while (historyBytes.current > HISTORY_BYTES && undo.current.length > 1) {
      const removed = undo.current.shift()!;
      historyBytes.current -= removed.bytes;
    }
    if (undo.current.length > 100) {
      const removed = undo.current.shift()!;
      historyBytes.current -= removed.bytes;
    }
    refreshHistory(value => value + 1);
  };

  const recordPixels = (id: number, before: ImageData, after: ImageData) => {
    if (pixelsDiffer(before.data, after.data)) record({ type: "pixels", id, before, after, bytes: before.data.byteLength + after.data.byteLength });
  };

  const changeLayerSnapshot = (next: LayerSnapshot) => {
    const before = snapshotLayers();
    const after = copyLayerSnapshot(next);
    const beforeIds = new Set(before.layers.map(layer => layer.id));
    const afterIds = new Set(after.layers.map(layer => layer.id));
    const changedCanvases = [
      ...before.layers.filter(layer => !afterIds.has(layer.id)),
      ...after.layers.filter(layer => !beforeIds.has(layer.id)),
    ];
    const bytes = changedCanvases.reduce((sum, layer) => sum + layer.canvas.width * layer.canvas.height * 4, 0);
    record({ type: "layers", before, after, bytes: Math.min(bytes, HISTORY_BYTES) });
    layersRef.current = after.layers;
    maskVisibleRef.current = after.maskVisible;
    setLayers(after.layers);
    setMaskVisible(after.maskVisible);
    redraw();
  };

  const history = (back: boolean) => {
    if (!readyRef.current || stroke.current || pan.current || selectionDrag.current || selectionMove.current) return;
    const from = back ? undo.current : redo.current;
    const to = back ? redo.current : undo.current;
    const action = from.pop();
    if (!action) return;
    if (action.type === "pixels") {
      const canvas = action.id === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === action.id)?.canvas;
      canvas?.getContext("2d")?.putImageData(back ? action.before : action.after, 0, 0);
      to.push(action);
      redraw();
    } else {
      const next = copyLayerSnapshot(back ? action.before : action.after);
      layersRef.current = next.layers;
      maskVisibleRef.current = next.maskVisible;
      setLayers(next.layers);
      setMaskVisible(next.maskVisible);
      if (activeId !== MASK_LAYER_ID && !next.layers.some(layer => layer.id === activeId)) setActiveId(next.layers.at(-1)?.id ?? MASK_LAYER_ID);
      to.push(action);
      redraw();
    }
    refreshHistory(value => value + 1);
  };
  historyRef.current = history;

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const size = naturalSize.current;
    if (!size || !rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(size.width - 1, (event.clientX - rect.left) * size.width / rect.width)),
      y: Math.max(0, Math.min(size.height - 1, (event.clientY - rect.top) * size.height / rect.height)),
    };
  };

  const layerPoint = (value: Point, canvas: HTMLCanvasElement): Point => ({
    x: value.x * canvas.width / (naturalSize.current?.width ?? canvas.width),
    y: value.y * canvas.height / (naturalSize.current?.height ?? canvas.height),
  });

  const pixelPoint = (value: Point, canvas: HTMLCanvasElement): Point => {
    const mapped = layerPoint(value, canvas);
    return { x: Math.max(0, Math.min(canvas.width - 1, Math.floor(mapped.x))), y: Math.max(0, Math.min(canvas.height - 1, Math.floor(mapped.y))) };
  };

  const selectionContains = (rect: PixelRect, value: Point) => {
    const canvas = activeCanvas();
    if (!canvas) return false;
    const current = pixelPoint(value, canvas);
    return current.x >= rect.x && current.y >= rect.y && current.x < rect.x + rect.width && current.y < rect.y + rect.height;
  };

  const selectionFromPoints = (start: Point, end: Point): PixelRect => {
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x) + 1, height: Math.abs(end.y - start.y) + 1 };
  };

  const draw = (event: PointerEvent<HTMLDivElement>) => {
    const currentStroke = stroke.current;
    if (!currentStroke || currentStroke.pointerId !== event.pointerId) return;
    const canvas = currentStroke.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === currentStroke.layerId)?.canvas;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const current = layerPoint(point(event), canvas);
    const brushSize = currentStroke.layerId === MASK_LAYER_ID ? maskBrushGridWidth(size) : Math.max(1, Math.min(256, Math.floor(size)));
    if (currentStroke.layerId === MASK_LAYER_ID) {
      const from = currentStroke.last ?? { x: Math.floor(current.x), y: Math.floor(current.y) };
      const to = { x: Math.floor(current.x), y: Math.floor(current.y) };
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = paintMaskGridStroke(image.data, canvas.width, canvas.height, from, to, brushSize, squareBrush, !currentStroke.erase);
      context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      currentStroke.last = to;
      redraw();
      return;
    } else {
      context.globalCompositeOperation = currentStroke.erase ? "destination-out" : "source-over";
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = brushSize;
      context.lineCap = squareBrush ? "square" : "round";
      context.lineJoin = squareBrush ? "miter" : "round";
    }
    context.beginPath();
    if (currentStroke.last) {
      context.moveTo(currentStroke.last.x, currentStroke.last.y);
      context.lineTo(current.x, current.y);
      context.stroke();
    } else if (squareBrush) {
      context.fillRect(current.x - brushSize / 2, current.y - brushSize / 2, brushSize, brushSize);
    } else {
      context.arc(current.x, current.y, brushSize / 2, 0, Math.PI * 2);
      context.fill();
    }
    context.globalCompositeOperation = "source-over";
    currentStroke.last = current;
    redraw();
  };

  const fillAt = (event: PointerEvent<HTMLDivElement>) => {
    if (activeId !== MASK_LAYER_ID && !layersRef.current.find(layer => layer.id === activeId)?.visible) {
      setSaveError("当前绘画图层已隐藏，请先显示它再编辑。"); return;
    }
    const canvas = activeCanvas();
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    const seed = pixelPoint(point(event), canvas);
    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    let pixels: Uint8ClampedArray;
    if (activeId === MASK_LAYER_ID) {
      const region = floodFillMask(targetToRgba(before.data), canvas.width, canvas.height, seed.x, seed.y, 0);
      pixels = colorizeMask(before.data, region, currentErase ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    } else {
      const merged = makeCanvas(canvas.width, canvas.height);
      const mergedContext = merged.getContext("2d", { willReadFrequently: true });
      if (!mergedContext) return;
      if (sourceImage.current) mergedContext.drawImage(sourceImage.current, 0, 0);
      for (const layer of layersRef.current) if (layer.visible) mergedContext.drawImage(layer.canvas, 0, 0);
      const mergedPixels = mergedContext.getImageData(0, 0, canvas.width, canvas.height);
      const region = floodFillMask(mergedPixels.data, canvas.width, canvas.height, seed.x, seed.y, 24);
      pixels = colorizeMask(before.data, region, colorTuple(color));
    }
    if (!pixelsDiffer(before.data, pixels)) return;
    const after = new ImageData(pixels, canvas.width, canvas.height);
    context.putImageData(after, 0, 0);
    recordPixels(activeId, before, after);
    setSaveError("");
    redraw();
  };

  const currentErase = tool === "eraser";

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || savingRef.current || event.button !== 0 || stroke.current || pan.current || selectionDrag.current || selectionMove.current) return;
    event.currentTarget.focus({ preventScroll: true });
    if (tool === "pan" || spaceDown.current) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pan.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: panOffset.x, y: panOffset.y };
      return;
    }
    const current = point(event);
    const canvas = activeCanvas();
    if (!canvas) return;
    if (activeId !== MASK_LAYER_ID && !layersRef.current.find(layer => layer.id === activeId)?.visible) {
      setSaveError("当前绘画图层已隐藏，请先显示它再编辑。"); return;
    }
    if (tool === "fill") { fillAt(event); return; }
    if (tool === "select") {
      if (selectionRef.current && selectionContains(selectionRef.current, current)) {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        const selected = selectionRef.current;
        const before = context.getImageData(0, 0, canvas.width, canvas.height);
        event.currentTarget.setPointerCapture(event.pointerId);
        selectionMove.current = { pointerId: event.pointerId, layerId: activeId, rect: { ...selected }, anchor: pixelPoint(current, canvas), before, dx: 0, dy: 0 };
      } else {
        event.currentTarget.setPointerCapture(event.pointerId);
        selectionDrag.current = { pointerId: event.pointerId, start: pixelPoint(current, canvas) };
        selectionDraftRef.current = { x: Math.floor(layerPoint(current, canvas).x), y: Math.floor(layerPoint(current, canvas).y), width: 1, height: 1 };
        setSelectionPreview(selectionDraftRef.current);
        redraw();
      }
      event.preventDefault();
      return;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke.current = { pointerId: event.pointerId, layerId: activeId, before, last: null, erase: currentErase };
    draw(event);
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const panning = pan.current;
    if (panning?.pointerId === event.pointerId) { setPanOffset({ x: panning.x + event.clientX - panning.startX, y: panning.y + event.clientY - panning.startY }); return; }
    const moving = selectionMove.current;
    if (moving?.pointerId === event.pointerId) {
      const canvas = moving.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === moving.layerId)?.canvas;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      const current = pixelPoint(point(event), canvas);
      const requestedX = current.x - moving.anchor.x;
      const requestedY = current.y - moving.anchor.y;
      moving.dx = Math.max(-moving.rect.x, Math.min(canvas.width - moving.rect.x - moving.rect.width, requestedX));
      moving.dy = Math.max(-moving.rect.y, Math.min(canvas.height - moving.rect.y - moving.rect.height, requestedY));
      const pixels = moving.layerId === MASK_LAYER_ID
        ? moveMaskSelectionPixels(moving.before.data, canvas.width, canvas.height, moving.rect, moving.dx, moving.dy)
        : moveLayerSelection(moving.before.data, canvas.width, canvas.height, moving.rect, moving.dx, moving.dy);
      context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      const next = { ...moving.rect, x: moving.rect.x + moving.dx, y: moving.rect.y + moving.dy };
      selectionDraftRef.current = next;
      setSelectionPreview(next);
      redraw();
      return;
    }
    const selecting = selectionDrag.current;
    if (selecting?.pointerId === event.pointerId) {
      const canvas = activeCanvas();
      if (!canvas) return;
      selectionDraftRef.current = selectionFromPoints(selecting.start, pixelPoint(point(event), canvas));
      setSelectionPreview(selectionDraftRef.current);
      redraw();
      return;
    }
    draw(event);
  };

  const pointerEnd = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const panning = pan.current;
    if (panning?.pointerId === event.pointerId) {
      if (cancelled) setPanOffset({ x: panning.x, y: panning.y });
      else setPanOffset({ x: panning.x + event.clientX - panning.startX, y: panning.y + event.clientY - panning.startY });
      pan.current = null;
      return;
    }
    const currentStroke = stroke.current;
    if (currentStroke?.pointerId === event.pointerId) {
      const canvas = currentStroke.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === currentStroke.layerId)?.canvas;
      const context = canvas?.getContext("2d", { willReadFrequently: true });
      if (cancelled) context?.putImageData(currentStroke.before, 0, 0);
      else if (canvas && context) {
        draw(event);
        const after = context.getImageData(0, 0, canvas.width, canvas.height);
        recordPixels(currentStroke.layerId, currentStroke.before, after);
      }
      stroke.current = null;
      redraw();
      return;
    }
    const selecting = selectionDrag.current;
    if (selecting?.pointerId === event.pointerId) {
      selectionDrag.current = null;
      const canvas = activeCanvas();
      if (canvas && !cancelled) {
        const next = selectionFromPoints(selecting.start, pixelPoint(point(event), canvas));
        selectionRef.current = next;
        selectionDraftRef.current = null;
        setSelection(next);
      } else selectionDraftRef.current = null;
      setSelectionPreview(null);
      redraw();
      return;
    }
    const moving = selectionMove.current;
    if (moving?.pointerId === event.pointerId) {
      const canvas = moving.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === moving.layerId)?.canvas;
      const context = canvas?.getContext("2d", { willReadFrequently: true });
      if (!canvas || !context) return;
      if (cancelled) {
        context.putImageData(moving.before, 0, 0);
        selectionRef.current = moving.rect;
      } else {
        const after = context.getImageData(0, 0, canvas.width, canvas.height);
        recordPixels(moving.layerId, moving.before, after);
        selectionRef.current = { ...moving.rect, x: moving.rect.x + moving.dx, y: moving.rect.y + moving.dy };
      }
      selectionMove.current = null;
      selectionDraftRef.current = null;
      setSelectionPreview(null);
      setSelection(selectionRef.current);
      redraw();
    }
  };

  const addLayer = () => {
    const size = naturalSize.current;
    if (!readyRef.current || !size || !ordinaryLayersSupported || layersRef.current.length >= MAX_DRAW_LAYERS) {
      setSaveError(`绘画图层要求图片不超过 ${MAX_CANVAS_SIDE}×${MAX_CANVAS_SIDE} 且总像素不超过 ${MAX_CANVAS_PIXELS.toLocaleString()}。蒙版本身仍可继续编辑。`);
      return;
    }
    const id = nextLayerId.current++;
    const next = [...layersRef.current, { id, name: `绘画 ${layersRef.current.length + 1}`, visible: true, canvas: makeCanvas(size.width, size.height) }];
    changeLayerSnapshot({ layers: next, maskVisible: maskVisibleRef.current });
    setActiveId(id);
    selectionRef.current = null;
    selectionDraftRef.current = null;
    setSelection(null);
    setSelectionPreview(null);
    setTool("brush");
    setSaveError("");
  };

  const mutateLayer = (change: (next: DrawLayer[]) => DrawLayer[]) => {
    const next = change(layersRef.current.map(layer => ({ ...layer })));
    changeLayerSnapshot({ layers: next, maskVisible: maskVisibleRef.current });
  };

  const resetActiveLayer = () => {
    const canvas = activeCanvas();
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    if (activeId === MASK_LAYER_ID) { context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height); }
    else context.clearRect(0, 0, canvas.width, canvas.height);
    const after = context.getImageData(0, 0, canvas.width, canvas.height);
    recordPixels(activeId, before, after);
    selectionRef.current = null;
    selectionDraftRef.current = null;
    setSelection(null);
    setSelectionPreview(null);
    setSaveError("");
    redraw();
  };

  const maskDataUrl = () => {
    const mask = maskCanvas.current;
    const size = naturalSize.current;
    const context = mask?.getContext("2d", { willReadFrequently: true });
    if (!mask || !size || !context) throw new Error("蒙版尚未就绪。");
    const pixels = expandMaskPixels(context.getImageData(0, 0, mask.width, mask.height).data, mask.width, mask.height, size.width, size.height);
    const output = makeCanvas(size.width, size.height);
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("无法生成源图尺寸的蒙版 PNG。");
    outputContext.putImageData(new ImageData(pixels, size.width, size.height), 0, 0);
    const url = output.toDataURL("image/png");
    if (!url.startsWith("data:image/png;base64,")) throw new Error("蒙版 PNG 编码失败。");
    return url;
  };

  const buildSaveProject = async (): Promise<{ source?: string; project?: CanvasProject }> => {
    const size = naturalSize.current;
    const source = sourceImage.current;
    if (!size || !source) throw new Error("源图尚未就绪。");
    if (!projectLoaded.current && layersRef.current.length === 0) return {};
    const composite = makeCanvas(size.width, size.height);
    const context = composite.getContext("2d");
    if (!context) throw new Error("无法生成编辑后的源图。");
    context.drawImage(source, 0, 0);
    for (const layer of layersRef.current) if (layer.visible) context.drawImage(layer.canvas, 0, 0);
    const url = composite.toDataURL("image/png");
    if (!url.startsWith("data:image/png;base64,")) throw new Error("编辑后的源图编码失败。");
    if (!sourceBase.current) {
      const baseCanvas = makeCanvas(size.width, size.height);
      const baseContext = baseCanvas.getContext("2d");
      if (!baseContext) throw new Error("无法保存原图底层。");
      baseContext.drawImage(source, 0, 0);
      sourceBase.current = await canvasBlob(baseCanvas);
    }
    const savedLayers = layersRef.current.length ? layersRef.current : [{
      id: nextLayerId.current++, name: "绘画 1", visible: true, canvas: makeCanvas(size.width, size.height),
    }];
    const project: CanvasProject = {
      version: 1,
      width: size.width,
      height: size.height,
      base: sourceBase.current,
      layers: await Promise.all(savedLayers.map(async layer => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        blob: await canvasBlob(layer.canvas),
      }))),
    };
    validateCanvasProject(project);
    projectLoaded.current = true;
    return { source: url, project };
  };

  const save = async () => {
    if (!readyRef.current || savingRef.current) return;
    const mask = maskCanvas.current;
    const context = mask?.getContext("2d", { willReadFrequently: true });
    if (!mask || !context) return;
    if (!hasMaskSelection(context.getImageData(0, 0, mask.width, mask.height).data)) {
      setSaveError("请先涂抹要重绘的区域。"); return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const maskUrl = maskDataUrl();
      const artifacts = await buildSaveProject();
      await onSave(maskUrl.slice("data:image/png;base64,".length),
        artifacts.source?.slice("data:image/png;base64,".length), artifacts.project);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "蒙版保存失败。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    if (savingRef.current) return;
    const next = Math.max(0.25, Math.min(8, zoom * factor));
    if (clientX !== undefined && clientY !== undefined && stage.current) {
      const bounds = stage.current.getBoundingClientRect();
      const x = clientX - (bounds.left + bounds.width / 2);
      const y = clientY - (bounds.top + bounds.height / 2);
      setPanOffset(current => ({ x: x - (x - current.x) * next / zoom, y: y - (y - current.y) * next / zoom }));
    }
    setZoom(next);
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (!ready || savingRef.current) return;
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dialog.current?.contains(event.target as Node)) return;
      const active = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(active?.isContentEditable || active?.closest("input, textarea, select, [contenteditable='true']"));
      if (event.key === "Escape") {
        event.preventDefault();
        if (savingRef.current) return;
        let cancelledAction = false;
        if (stroke.current) {
          const current = stroke.current;
          const canvas = current.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === current.layerId)?.canvas;
          canvas?.getContext("2d")?.putImageData(current.before, 0, 0);
          stroke.current = null;
          cancelledAction = true;
        }
        if (selectionMove.current) {
          const moving = selectionMove.current;
          const canvas = moving.layerId === MASK_LAYER_ID ? maskCanvas.current : layersRef.current.find(layer => layer.id === moving.layerId)?.canvas;
          canvas?.getContext("2d")?.putImageData(moving.before, 0, 0);
          selectionMove.current = null;
          cancelledAction = true;
        }
        if (pan.current) {
          setPanOffset({ x: pan.current.x, y: pan.current.y });
          pan.current = null;
          cancelledAction = true;
        }
        if (selectionDrag.current) {
          selectionDrag.current = null;
          cancelledAction = true;
        }
        if (cancelledAction || selectionRef.current || selectionDraftRef.current || toolRef.current === "select") {
          selectionRef.current = null;
          selectionDraftRef.current = null;
          setSelection(null);
          setSelectionPreview(null);
          setTool("brush");
          redrawRef.current();
        } else closeRef.current();
        return;
      }
      if (typing) return;
      if (event.code === "Space") { spaceDown.current = true; event.preventDefault(); return; }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "z") { event.preventDefault(); historyRef.current(event.shiftKey ? false : true); }
        else if (event.key.toLowerCase() === "y") { event.preventDefault(); historyRef.current(false); }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "b") setTool("brush");
      else if (key === "e") setTool("eraser");
      else if (key === "g") setTool("fill");
      else if (key === "m") setTool("select");
      else if (key === "h") setTool("pan");
    };
    const handleKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") spaceDown.current = false; };
    dialog.current?.focus({ preventScroll: true });
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      spaceDown.current = false;
    };
  }, []);

  const activeLayerTitle = activeIsMask ? "绘制蒙版" : layers.find(layer => layer.id === activeId)?.name ?? "绘画";
  const drawingLayersAllowed = layers.length < MAX_DRAW_LAYERS && ordinaryLayersSupported;
  const selectionStyle = (() => {
    const rect = selectionPreview ?? selection;
    const canvas = activeCanvas();
    const size = naturalSize.current;
    if (!rect || !canvas || !size) return undefined;
    return {
      left: `${rect.x / canvas.width * 100}%`, top: `${rect.y / canvas.height * 100}%`,
      width: `${rect.width / canvas.width * 100}%`, height: `${rect.height / canvas.height * 100}%`,
    };
  })();

  return <div className="mask-editor-backdrop">
    <section ref={dialog} className={`mask-editor${saving ? " is-saving" : ""}`} role="dialog" aria-modal="true" aria-label="绘制重绘蒙版" aria-busy={saving} tabIndex={-1}>
      <header className="mask-editor-topbar">
        <section className="mask-editor-settings" aria-label="蒙版画笔设置">
          <h2>{activeLayerTitle}</h2>
          <label className="mask-editor-size">
            <span>笔刷大小</span>
            <input aria-label="笔刷大小" type="number" min={1} max={256} disabled={saving} value={size} onChange={event => setSize(Math.max(1, Math.min(256, Number(event.currentTarget.value) || 1)))} />
            <span aria-hidden="true">{activeIsMask ? "格" : "px"}</span>
            <input aria-label="笔刷大小滑块" type="range" min={1} max={256} disabled={saving} value={size} onChange={event => setSize(Number(event.currentTarget.value))} />
          </label>
          <button className="mask-editor-square" type="button" disabled={saving} aria-pressed={squareBrush} onClick={() => setSquareBrush(value => !value)}><span className="mask-editor-square-icon" aria-hidden="true" />方形笔刷</button>
          <div className="mask-editor-palette" role="group" aria-label={activeIsMask ? "蒙版显示颜色" : "绘画颜色"}>
            {PALETTE.map(value => <button key={value} type="button" disabled={saving} aria-label={`颜色 ${value}`} aria-pressed={(activeIsMask ? maskTint : color) === value}
              style={{ backgroundColor: value }} onClick={() => activeIsMask ? setMaskTint(value) : setColor(value)} />)}
          </div>
        </section>
        <div className="mask-editor-save-actions">
          <button className="mask-editor-download" type="button" disabled={!ready || saving} title="下载蒙版 PNG" aria-label="下载蒙版 PNG" onClick={() => {
            try { const link = document.createElement("a"); link.href = maskDataUrl(); link.download = "inpaint-mask.png"; link.click(); }
            catch (error) { setSaveError(error instanceof Error ? error.message : "蒙版下载失败。"); }
          }}><Download size={17} /></button>
          <button className="mask-editor-save" type="button" disabled={!ready || saving} onClick={() => void save()}><Check size={16} />{saving ? "保存中" : "保存"}</button>
          <button className="mask-editor-close" type="button" disabled={saving} aria-label="关闭蒙版编辑器" title="关闭" onClick={onClose}><X size={18} /></button>
        </div>
      </header>

      <aside className={`mask-editor-layers${layersOpen ? "" : " is-collapsed"}`} aria-label="图层">
        <div className="mask-editor-layers-heading">
          <button type="button" className="mask-editor-layers-toggle" aria-expanded={layersOpen} onClick={() => setLayersOpen(value => !value)}><ChevronDown size={14} />图层 {layers.length + 2}</button>
          <button type="button" disabled={!ready || saving || !drawingLayersAllowed} title={!ordinaryLayersSupported ? "图片尺寸超过绘画图层限制，仍可编辑低分辨率蒙版" : layers.length >= MAX_DRAW_LAYERS ? `最多 ${MAX_DRAW_LAYERS} 个绘画图层` : "添加绘画图层"} onClick={addLayer}>＋</button>
        </div>
        <ul>
          {[...layers].reverse().map((layer, reverseIndex) => {
            const index = layers.length - 1 - reverseIndex;
            return <li key={layer.id} className={activeId === layer.id ? "selected" : ""}>
          <button type="button" disabled={saving} className="mask-editor-layer-select" aria-pressed={activeId === layer.id} onClick={() => {
              setActiveId(layer.id); selectionRef.current = null; selectionDraftRef.current = null; setSelection(null); setSelectionPreview(null); setTool("brush"); redraw();
              }}><canvas width="32" height="24" ref={thumb => { if (!thumb) return; const context = thumb.getContext("2d"); if (context) { context.clearRect(0, 0, 32, 24); context.drawImage(layer.canvas, 0, 0, 32, 24); } }} />{layer.name}</button>
              <button type="button" disabled={saving} aria-label={`${layer.visible ? "隐藏" : "显示"}${layer.name}`} title={layer.visible ? "隐藏" : "显示"} onClick={() => mutateLayer(next => next.map(item => item.id === layer.id ? { ...item, visible: !item.visible } : item))}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
              <button type="button" aria-label={`上移${layer.name}`} disabled={saving || index === layers.length - 1} onClick={() => mutateLayer(next => { const from = next.findIndex(item => item.id === layer.id); if (from >= next.length - 1) return next; [next[from], next[from + 1]] = [next[from + 1], next[from]]; return next; })}>↑</button>
              <button type="button" aria-label={`下移${layer.name}`} disabled={saving || index === 0} onClick={() => mutateLayer(next => { const from = next.findIndex(item => item.id === layer.id); if (from <= 0) return next; [next[from], next[from - 1]] = [next[from - 1], next[from]]; return next; })}>↓</button>
              <button type="button" disabled={saving} aria-label={`删除${layer.name}`} title="删除绘画图层" onClick={() => {
                const next = layersRef.current.filter(item => item.id !== layer.id);
                changeLayerSnapshot({ layers: next, maskVisible: maskVisibleRef.current });
                if (activeId === layer.id) setActiveId(next.at(-1)?.id ?? MASK_LAYER_ID);
                selectionRef.current = null; selectionDraftRef.current = null; setSelection(null); setSelectionPreview(null); setTool("brush");
              }}><Trash2 size={14} /></button>
            </li>;
          })}
          <li className={`mask-editor-mask-layer${activeId === MASK_LAYER_ID ? " selected" : ""}`}>
            <button type="button" disabled={saving} className="mask-editor-layer-select" aria-pressed={activeId === MASK_LAYER_ID} onClick={() => {
              setActiveId(MASK_LAYER_ID); selectionRef.current = null; selectionDraftRef.current = null; setSelection(null); setSelectionPreview(null); setTool("brush"); redraw();
            }}><canvas width="32" height="24" ref={thumb => { const mask = maskCanvas.current; if (!thumb || !mask) return; const context = thumb.getContext("2d"); if (context) { context.clearRect(0, 0, 32, 24); if (maskVisibleRef.current) context.drawImage(mask, 0, 0, 32, 24); } }} />蒙版</button>
            <button type="button" disabled={saving} aria-label={`${maskVisible ? "隐藏" : "显示"}蒙版`} onClick={() => changeLayerSnapshot({ layers: layersRef.current.map(layer => ({ ...layer })), maskVisible: !maskVisibleRef.current })}>{maskVisible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          </li>
          <li className="mask-editor-source-layer"><canvas width="32" height="24" ref={thumb => {
            const source = sourceImage.current;
            if (!thumb || !source) return;
            const context = thumb.getContext("2d");
            if (context) { context.clearRect(0, 0, 32, 24); context.drawImage(source, 0, 0, 32, 24); }
          }} /><span>原图</span><span>锁定</span></li>
        </ul>
        {!ordinaryLayersSupported && <p>大图模式：保留原尺寸蒙版功能，绘画层不可用。</p>}
      </aside>

      <main className="mask-editor-stage" ref={stage} onWheel={onWheel}>
        <div className="mask-editor-image-wrap" ref={imageWrap}
          style={displaySize ? { width: displaySize.width, height: displaySize.height, transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})` } : undefined}
          tabIndex={0} aria-label="图片与蒙版画布" role="application"
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event, false)}
          onPointerCancel={event => pointerEnd(event, true)} onLostPointerCapture={event => pointerEnd(event, true)}>
          <img src={sourceUrl} alt="待重绘图片" draggable={false} />
          <canvas ref={paintComposite} className="mask-editor-paint-composite" aria-hidden="true" />
          <canvas ref={overlayCanvas} className="mask-editor-overlay" aria-hidden="true" />
          {selectionStyle && <div className="mask-editor-selection" style={selectionStyle} aria-hidden="true" />}
        </div>
        <div className="mask-editor-hint" role={saveError ? "alert" : undefined}>{saveError || (selection ? `选区 ${selection.width} × ${selection.height}；拖动可移动当前图层，Esc 清除。` : "红色蒙版区域会重新绘制；绘画图层会与原图合成")}</div>
      </main>

      <div className="mask-editor-toolbar" role="toolbar" aria-label="蒙版工具">
        <button type="button" disabled={saving} className={tool === "brush" ? "selected" : ""} aria-pressed={tool === "brush"} aria-label="画笔" title="画笔（B）" onClick={() => setTool("brush")}><Paintbrush size={18} /></button>
        <button type="button" disabled={saving} className={tool === "eraser" ? "selected" : ""} aria-pressed={tool === "eraser"} aria-label="橡皮擦" title="橡皮擦（E）" onClick={() => setTool("eraser")}><Eraser size={18} /></button>
        <button type="button" disabled={saving} className={tool === "fill" ? "selected" : ""} aria-pressed={tool === "fill"} aria-label="填充" title="填充（G）" onClick={() => setTool("fill")}><PaintBucket size={18} /></button>
        <button type="button" disabled={saving} className={tool === "select" ? "selected" : ""} aria-pressed={tool === "select"} aria-label="矩形选区" title="矩形选区（M）" onClick={() => setTool("select")}><Square size={18} /></button>
        <button type="button" disabled={saving} className={tool === "pan" ? "selected" : ""} aria-pressed={tool === "pan"} aria-label="抓手" title="抓手（H / 空格）" onClick={() => setTool("pan")}><Hand size={18} /></button>
        <span className="mask-editor-tool-divider" aria-hidden="true" />
        <button type="button" aria-label="清空当前图层" title="清空当前图层" disabled={!ready || saving} onClick={resetActiveLayer}><RotateCcw size={18} /></button>
        <button type="button" aria-label="撤销" title="撤销（Ctrl/⌘ Z）" disabled={!undo.current.length || !ready || saving} onClick={() => history(true)}><Undo2 size={18} /></button>
        <button type="button" aria-label="重做" title="重做（Ctrl/⌘ Shift Z）" disabled={!redo.current.length || !ready || saving} onClick={() => history(false)}><Redo2 size={18} /></button>
        <button type="button" aria-label="缩小" title="缩小" disabled={saving} onClick={() => zoomAt(1 / 1.25)}><ZoomOut size={18} /></button>
        <button type="button" aria-label="适应画布" title={`适应画布 · ${Math.round(zoom * 100)}%`} disabled={saving} onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}>适应</button>
        <button type="button" aria-label="放大" title="放大" disabled={saving} onClick={() => zoomAt(1.25)}><ZoomIn size={18} /></button>
      </div>
      <canvas ref={maskCanvas} className="mask-editor-mask-data" aria-hidden="true" />
    </section>
  </div>;
}

function targetToRgba(pixels: Uint8ClampedArray) {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const value = pixels[i] > 155 ? 255 : 0;
    out[i] = out[i + 1] = out[i + 2] = value;
    out[i + 3] = 255;
  }
  return out;
}
