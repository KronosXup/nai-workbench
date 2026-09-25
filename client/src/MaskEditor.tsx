import { useEffect, useRef, useState } from "react";
import { Eraser, Paintbrush, RotateCcw, X, Check } from "lucide-react";

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
  const canvas = useRef<HTMLCanvasElement>(null);
  const undo = useRef<ImageData[]>([]), redo = useRef<ImageData[]>([]);
  const [, refreshHistory] = useState(0);
  const remember = () => {
    const c = canvas.current!;
    undo.current.push(c.getContext("2d")!.getImageData(0,0,c.width,c.height));
    // Bound raw bitmap history to approximately 64 MiB.
    const limit = Math.max(1, Math.min(20, Math.floor(64*1024*1024/(c.width*c.height*4))));
    undo.current = undo.current.slice(-limit); redo.current = []; refreshHistory(v=>v+1);
  };
  const history = (back: boolean) => {
    const from = back ? undo.current : redo.current, to = back ? redo.current : undo.current;
    const frame = from.pop(); if(!frame)return;
    const c = canvas.current!, ctx=c.getContext("2d")!;to.push(ctx.getImageData(0,0,c.width,c.height));ctx.putImageData(frame,0,0);refreshHistory(v=>v+1);
  };
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState(50);
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    undo.current = []; redo.current = [];
    const img = new Image();
    img.onload = () => {
      const c = canvas.current;
      if (!c || cancelled) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const context = c.getContext("2d")!;
      context.fillStyle = "#000";
      context.fillRect(0, 0, c.width, c.height);
      if (initial) {
        const mask = new Image();
        // Do not accept brush strokes until the saved mask has finished loading.
        mask.onload = () => { if (!cancelled) { context.drawImage(mask, 0, 0, c.width, c.height); setReady(true); } };
        mask.src = `data:image/png;base64,${initial}`;
      } else setReady(true);
    };
    img.src = `data:image/png;base64,${image}`;
    return () => { cancelled = true; };
  }, [image, initial]);
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = canvas.current!,
      rect = c.getBoundingClientRect(),
      ctx = c.getContext("2d")!,
      p = {
        x: ((event.clientX - rect.left) * c.width) / rect.width,
        y: ((event.clientY - rect.top) * c.height) / rect.height,
      };
    ctx.strokeStyle = erase ? "#000" : "#fff";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = (size * c.width) / rect.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (last.current) {
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else {
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    last.current = p;
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal mask-modal"
        role="dialog"
        aria-modal="true"
        aria-label="绘制重绘区域"
      >
        <header>
          <div>
            <small>IMAGE EDITOR</small>
            <h2>绘制重绘区域</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        <div className="mask-tools">
          <button disabled={!undo.current.length || !ready} onClick={()=>history(true)}>撤销</button>
          <button disabled={!redo.current.length || !ready} onClick={()=>history(false)}>重做</button>
          <button
            className={!erase ? "active" : ""}
            onClick={() => setErase(false)}
          >
            <Paintbrush size={16} />
            画笔
          </button>
          <button
            className={erase ? "active" : ""}
            onClick={() => setErase(true)}
          >
            <Eraser size={16} />
            擦除
          </button>
          <label>
            笔刷{" "}
            <input
              aria-label="笔刷大小"
              type="range"
              min="5"
              max="160"
              value={size}
              onChange={(e) => setSize(+e.target.value)}
            />
          </label>
          <button
            disabled={!ready}
            onClick={() => {
              remember();
              const c = canvas.current!,
                ctx = c.getContext("2d")!;
              ctx.fillStyle = "#000";
              ctx.fillRect(0, 0, c.width, c.height);
            }}
          >
            <RotateCcw size={16} />
            清空
          </button>
        </div>
        <p className="muted">涂白的区域会重新绘制。黑色区域保留。</p>
        <div className="mask-stage">
          <img src={`data:image/png;base64,${image}`} alt="待重绘图片" />
          <canvas
            ref={canvas}
            onPointerDown={(e) => {
              if(!ready)return;
              remember();
              drawing.current = true;
              last.current = null;
              e.currentTarget.setPointerCapture(e.pointerId);
              draw(e);
            }}
            onPointerMove={draw}
            onPointerUp={() => {
              drawing.current = false;
              last.current = null;
            }}
            onPointerCancel={() => {
              drawing.current = false;
              last.current = null;
            }}
          />
        </div>
        <footer>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!ready}
            onClick={() =>
              onSave(canvas.current!.toDataURL("image/png").split(",")[1])
            }
          >
            <Check size={16} />
            应用蒙版
          </button>
        </footer>
      </section>
    </div>
  );
}
