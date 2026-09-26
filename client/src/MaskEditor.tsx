import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Eraser,
  Paintbrush,
  Redo2,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import "./maskEditor.css";

const MASK_TINT = { red: 247, green: 76, blue: 111 };
const MASK_TINT_OPACITY = 0.46;

export default function MaskEditor({
  image,
  initial,
  onClose,
  onSave,
}: {
  image: string;
  initial?: string;
  onClose: () => void;
  onSave: (base64: string) => void;
}) {
  const maskCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const imageWrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const undo = useRef<ImageData[]>([]);
  const redo = useRef<ImageData[]>([]);
  const readyRef = useRef(false);
  const drawing = useRef(false);
  const activePointer = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const naturalSize = useRef<{ width: number; height: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [, refreshHistory] = useState(0);
  const [size, setSize] = useState(50);
  const [erase, setErase] = useState(false);
  const [squareBrush, setSquareBrush] = useState(false);
  const [ready, setReady] = useState(false);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);

  const fitImageToStage = useCallback(() => {
    const sourceSize = naturalSize.current;
    const area = stage.current;
    if (!sourceSize || !area) return;
    const bounds = area.getBoundingClientRect();
    const padding = window.getComputedStyle(area);
    const availableWidth = bounds.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    const availableHeight = bounds.height - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const scale = Math.min(availableWidth / sourceSize.width, availableHeight / sourceSize.height);
    const next = {
      width: Math.max(1, Math.round(sourceSize.width * scale)),
      height: Math.max(1, Math.round(sourceSize.height * scale)),
    };
    setDisplaySize((current) => current?.width === next.width && current.height === next.height ? current : next);
  }, []);

  const redrawOverlay = useCallback(() => {
    const mask = maskCanvas.current;
    const overlay = overlayCanvas.current;
    const bounds = imageWrap.current?.getBoundingClientRect();
    if (!readyRef.current || !mask || !overlay || !bounds?.width || !bounds.height) return;

    const deviceScale = Math.min(window.devicePixelRatio || 1, 2, 1800 / Math.max(bounds.width, bounds.height));
    const width = Math.max(1, Math.round(bounds.width * deviceScale));
    const height = Math.max(1, Math.round(bounds.height * deviceScale));
    if (overlay.width !== width) overlay.width = width;
    if (overlay.height !== height) overlay.height = height;

    const context = overlay.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(mask, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const coverage = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / (3 * 255);
      pixels.data[i] = MASK_TINT.red;
      pixels.data[i + 1] = MASK_TINT.green;
      pixels.data[i + 2] = MASK_TINT.blue;
      pixels.data[i + 3] = Math.round(coverage * MASK_TINT_OPACITY * 255);
    }
    context.putImageData(pixels, 0, 0);
  }, []);

  useEffect(() => {
    const wrapper = imageWrap.current;
    const area = stage.current;
    if (!wrapper || !area) return;
    const observer = new ResizeObserver(redrawOverlay);
    observer.observe(wrapper);
    const stageObserver = new ResizeObserver(fitImageToStage);
    stageObserver.observe(area);
    return () => {
      observer.disconnect();
      stageObserver.disconnect();
    };
  }, [fitImageToStage, redrawOverlay]);

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    setReady(false);
    undo.current = [];
    redo.current = [];
    refreshHistory((value) => value + 1);

    const source = new Image();
    source.onload = () => {
      const canvas = maskCanvas.current;
      if (!canvas || cancelled) return;
      naturalSize.current = { width: source.naturalWidth, height: source.naturalHeight };
      requestAnimationFrame(fitImageToStage);
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);

      const finishLoading = () => {
        if (cancelled) return;
        readyRef.current = true;
        setReady(true);
        requestAnimationFrame(redrawOverlay);
      };

      if (!initial) {
        finishLoading();
        return;
      }
      const savedMask = new Image();
      savedMask.onload = () => {
        if (!cancelled) {
          context.drawImage(savedMask, 0, 0, canvas.width, canvas.height);
          finishLoading();
        }
      };
      savedMask.src = `data:image/png;base64,${initial}`;
    };
    source.src = `data:image/png;base64,${image}`;
    return () => {
      cancelled = true;
    };
  }, [image, initial, fitImageToStage, redrawOverlay]);

  const remember = () => {
    const canvas = maskCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !readyRef.current) return;
    undo.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    // Keep the existing bitmap history budget so large source images stay bounded.
    const limit = Math.max(1, Math.min(20, Math.floor((64 * 1024 * 1024) / (canvas.width * canvas.height * 4))));
    undo.current = undo.current.slice(-limit);
    redo.current = [];
    refreshHistory((value) => value + 1);
  };

  const history = useCallback((back: boolean) => {
    const from = back ? undo.current : redo.current;
    const to = back ? redo.current : undo.current;
    const frame = from.pop();
    const canvas = maskCanvas.current;
    const context = canvas?.getContext("2d");
    if (!frame || !canvas || !context) return;
    to.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(frame, 0, 0);
    redrawOverlay();
    refreshHistory((value) => value + 1);
  }, [redrawOverlay]);

  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || activePointer.current !== event.pointerId) return;
    const mask = maskCanvas.current;
    const overlay = overlayCanvas.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const maskContext = mask?.getContext("2d");
    const overlayContext = overlay?.getContext("2d");
    if (!mask || !overlay || !maskContext || !overlayContext || !rect.width || !rect.height) return;

    const point = {
      x: ((event.clientX - rect.left) * mask.width) / rect.width,
      y: ((event.clientY - rect.top) * mask.height) / rect.height,
    };
    const previewPoint = {
      x: ((event.clientX - rect.left) * overlay.width) / rect.width,
      y: ((event.clientY - rect.top) * overlay.height) / rect.height,
    };
    const maskLineWidth = (size * mask.width) / rect.width;
    const overlayLineWidth = (size * overlay.width) / rect.width;

    maskContext.strokeStyle = erase ? "#000" : "#fff";
    maskContext.fillStyle = maskContext.strokeStyle;
    maskContext.lineWidth = maskLineWidth;
    maskContext.lineCap = squareBrush ? "square" : "round";
    maskContext.lineJoin = squareBrush ? "miter" : "round";
    maskContext.beginPath();
    if (last.current) {
      maskContext.moveTo(last.current.x, last.current.y);
      maskContext.lineTo(point.x, point.y);
      maskContext.stroke();
    } else if (squareBrush) {
      maskContext.fillRect(point.x - maskLineWidth / 2, point.y - maskLineWidth / 2, maskLineWidth, maskLineWidth);
    } else {
      maskContext.arc(point.x, point.y, maskLineWidth / 2, 0, Math.PI * 2);
      maskContext.fill();
    }

    overlayContext.globalCompositeOperation = erase ? "destination-out" : "source-over";
    overlayContext.globalAlpha = erase ? 1 : MASK_TINT_OPACITY;
    overlayContext.strokeStyle = `rgb(${MASK_TINT.red} ${MASK_TINT.green} ${MASK_TINT.blue})`;
    overlayContext.fillStyle = overlayContext.strokeStyle;
    overlayContext.lineWidth = overlayLineWidth;
    overlayContext.lineCap = squareBrush ? "square" : "round";
    overlayContext.lineJoin = squareBrush ? "miter" : "round";
    overlayContext.beginPath();
    if (last.current) {
      overlayContext.moveTo(last.current.x * overlay.width / mask.width, last.current.y * overlay.height / mask.height);
      overlayContext.lineTo(previewPoint.x, previewPoint.y);
      overlayContext.stroke();
    } else if (squareBrush) {
      overlayContext.fillRect(previewPoint.x - overlayLineWidth / 2, previewPoint.y - overlayLineWidth / 2, overlayLineWidth, overlayLineWidth);
    } else {
      overlayContext.arc(previewPoint.x, previewPoint.y, overlayLineWidth / 2, 0, Math.PI * 2);
      overlayContext.fill();
    }
    overlayContext.globalAlpha = 1;
    overlayContext.globalCompositeOperation = "source-over";
    last.current = point;
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const active = event.target instanceof HTMLElement ? event.target : null;
      if (!dialog.current?.contains(event.target as Node)) return;
      if (event.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        const focusable = controls ? [...controls] : [];
        if (!focusable.length) return;
        const first = focusable[0];
        const lastControl = focusable[focusable.length - 1];
        if (event.shiftKey && (active === first || active === dialog.current)) {
          event.preventDefault();
          lastControl.focus();
        } else if (!event.shiftKey && active === lastControl) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      const typing = Boolean(active?.isContentEditable || active?.closest("input, textarea, select, [contenteditable='true']"));
      if (typing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        history(event.shiftKey ? false : true);
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        history(false);
      }
    };
    const panel = dialog.current;
    panel?.focus({ preventScroll: true });
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [history]);

  return (
    <div className="mask-editor-backdrop">
      <section
        ref={dialog}
        className="mask-editor"
        role="dialog"
        aria-modal="true"
        aria-label="绘制重绘蒙版"
        tabIndex={-1}
      >
        <header className="mask-editor-topbar">
          <section className="mask-editor-settings" aria-label="蒙版画笔设置">
            <h2>绘制蒙版</h2>
            <label className="mask-editor-size">
              <span>笔刷大小</span>
              <input
                aria-label="笔刷大小（像素）"
                type="number"
                min={1}
                max={256}
                value={size}
                onChange={(event) => setSize(Math.max(1, Math.min(256, Number(event.currentTarget.value) || 1)))}
              />
              <span aria-hidden="true">px</span>
              <input
                aria-label="笔刷大小滑块"
                type="range"
                min={1}
                max={256}
                value={size}
                onChange={(event) => setSize(Number(event.currentTarget.value))}
              />
            </label>
            <button
              className="mask-editor-square"
              type="button"
              aria-pressed={squareBrush}
              onClick={() => setSquareBrush((value) => !value)}
            >
              <span className="mask-editor-square-icon" aria-hidden="true" />
              方形笔刷
            </button>
          </section>

          <div className="mask-editor-save-actions">
            <button
              className="mask-editor-save"
              type="button"
              disabled={!ready}
              onClick={() => {
                const canvas = maskCanvas.current;
                if (canvas) onSave(canvas.toDataURL("image/png").split(",")[1]);
              }}
            >
              <Check size={16} />
              保存并关闭
            </button>
            <button
              className="mask-editor-close"
              type="button"
              aria-label="关闭蒙版编辑器"
              title="关闭"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <main className="mask-editor-stage" ref={stage}>
          <div
            className="mask-editor-image-wrap"
            ref={imageWrap}
            style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
          >
            <img src={`data:image/png;base64,${image}`} alt="待重绘图片" draggable={false} />
            <canvas
              ref={overlayCanvas}
              className="mask-editor-overlay"
              aria-label="蒙版绘制画布"
              role="application"
              tabIndex={0}
              onPointerDown={(event) => {
                if (!ready || event.button !== 0 || activePointer.current !== null) return;
                remember();
                drawing.current = true;
                activePointer.current = event.pointerId;
                last.current = null;
                event.currentTarget.setPointerCapture(event.pointerId);
                draw(event);
              }}
              onPointerMove={draw}
              onPointerUp={(event) => {
                if (activePointer.current !== event.pointerId) return;
                drawing.current = false;
                activePointer.current = null;
                last.current = null;
                redrawOverlay();
              }}
              onPointerCancel={(event) => {
                if (activePointer.current !== event.pointerId) return;
                drawing.current = false;
                activePointer.current = null;
                last.current = null;
                redrawOverlay();
              }}
              onLostPointerCapture={(event) => {
                if (activePointer.current !== event.pointerId) return;
                drawing.current = false;
                activePointer.current = null;
                last.current = null;
                redrawOverlay();
              }}
            />
          </div>
          <p className="mask-editor-hint">红色区域会重新绘制，未涂区域会保留原图</p>
        </main>

        <div className="mask-editor-toolbar" role="toolbar" aria-label="蒙版工具">
          <button
            type="button"
            className={!erase ? "selected" : ""}
            aria-label="画笔"
            aria-pressed={!erase}
            title="画笔"
            onClick={() => setErase(false)}
          >
            <Paintbrush size={18} />
          </button>
          <button
            type="button"
            className={erase ? "selected" : ""}
            aria-label="橡皮擦"
            aria-pressed={erase}
            title="橡皮擦"
            onClick={() => setErase(true)}
          >
            <Eraser size={18} />
          </button>
          <span className="mask-editor-tool-divider" aria-hidden="true" />
          <button
            type="button"
            aria-label="清空蒙版"
            title="清空蒙版"
            disabled={!ready}
            onClick={() => {
              const canvas = maskCanvas.current;
              const context = canvas?.getContext("2d");
              if (!canvas || !context) return;
              remember();
              context.fillStyle = "#000";
              context.fillRect(0, 0, canvas.width, canvas.height);
              redrawOverlay();
            }}
          >
            <RotateCcw size={18} />
          </button>
          <button
            type="button"
            aria-label="撤销"
            title="撤销（Ctrl/⌘ Z）"
            disabled={!undo.current.length || !ready}
            onClick={() => history(true)}
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做（Ctrl/⌘ Shift Z）"
            disabled={!redo.current.length || !ready}
            onClick={() => history(false)}
          >
            <Redo2 size={18} />
          </button>
        </div>

        <canvas ref={maskCanvas} className="mask-editor-mask-data" aria-hidden="true" />
      </section>
    </div>
  );
}
