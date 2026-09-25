import { useEffect, useRef, useState } from 'react';
import { Check, Download, X } from 'lucide-react';
import type { PaletteMode, PixelBuffer, PixelSnapOptions, PixelSnapResult } from './pixelSnapAlgorithm';
import type { PixelSnapRequest, PixelSnapResponse } from './pixelSnap.worker';
import './localPixelSnap.css';

const MAX_SIDE = 4096;
const MAX_PIXELS = 4_194_304;
const MAX_SOURCE_LENGTH = 32 * 1024 * 1024;
const PREVIEW_TIMEOUT = 120_000;

export type LocalPixelSnapSave = { data: string; width: number; height: number };
export type LocalPixelSnapProps = {
  saveLabel?: string;
  image: string;
  width: number;
  height: number;
  onSave: (result: LocalPixelSnapSave) => void;
  onCancel: () => void;
};

function normalizeImage(value: string): string | null {
  if (value.length > MAX_SOURCE_LENGTH) return null;
  if (/^data:image\/(?:png|jpeg|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  if (/^[a-z\d+/=\s]+$/i.test(value)) return `data:image/png;base64,${value}`;
  return null;
}

type Source = { id: number; image: string; url: string; pixels: PixelBuffer };
type Preview = LocalPixelSnapSave & {
  url: string; key: string; pitch: number; paletteSize: number; confident: boolean; scale: number;
};

function encodePreview(result: PixelSnapResult, key: string): Preview {
  if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 ||
      result.width > MAX_SIDE || result.height > MAX_SIDE || result.width * result.height > MAX_PIXELS ||
      result.data.length !== result.width * result.height * 4) throw new Error('处理结果尺寸无效。');
  const canvas = document.createElement('canvas');
  canvas.width = result.width; canvas.height = result.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建预览画布。');
  const pixels = context.createImageData(result.width, result.height);
  pixels.data.set(result.data);
  context.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL('image/png');
  if (!url.startsWith('data:image/png;base64,')) throw new Error('浏览器无法编码 PNG。');
  if (url.length > 20 * 1024 * 1024) throw new Error('处理结果超过 20 MB，请减小原图。');
  return { data: url.slice('data:image/png;base64,'.length), url, key, width: result.width, height: result.height,
    pitch: result.pitch, paletteSize: result.paletteSize, confident: result.confident, scale: result.scale };
}

export default function LocalPixelSnap({ image, width, height, onSave, onCancel, saveLabel = '用作图生图源图' }: LocalPixelSnapProps) {
  const sourceVersion = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [pixelSize, setPixelSize] = useState(0);
  const [avoidRefining, setAvoidRefining] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('auto');
  const [paletteCount, setPaletteCount] = useState('64');
  const [upscale, setUpscale] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const paletteSize = Number(paletteCount);
  const invalidPalette = paletteMode === 'custom' && (!Number.isInteger(paletteSize) || paletteSize < 1 || paletteSize > 256);
  const validSize = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  const sourceMatches = source?.image === image && source.pixels.width === width && source.pixels.height === height;
  const key = `${source?.id}/${pixelSize}/${avoidRefining}/${paletteMode}/${paletteSize}/${upscale}/${retry}`;

  useEffect(() => {
    let cancelled = false;
    setSource(null); setPreview(null); setError(''); setBusy(false);
    if (!validSize) {
      setError('图片尺寸无效；最长边不能超过 4096 像素，总像素不能超过 419 万。');
      return;
    }
    const url = normalizeImage(image);
    if (!url) { setError('图片数据无效或过大，仅支持 PNG、JPEG、WebP、AVIF。'); return; }
    const loaded = new Image();
    loaded.onload = () => {
      if (cancelled) return;
      try {
        if (loaded.naturalWidth !== width || loaded.naturalHeight !== height) throw new Error('图片实际尺寸与传入的宽高不一致。');
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('浏览器无法读取图片。');
        context.drawImage(loaded, 0, 0);
        setSource({ id: ++sourceVersion.current, image, url, pixels: { width, height, data: context.getImageData(0, 0, width, height).data } });
      } catch (cause) { setError(cause instanceof Error ? cause.message : '图片无法在浏览器中处理。'); }
    };
    loaded.onerror = () => { if (!cancelled) setError('图片数据无法解码。'); };
    loaded.src = url;
    return () => { cancelled = true; loaded.src = ''; };
  }, [image, width, height, validSize]);

  useEffect(() => {
    if (!source || !sourceMatches || invalidPalette) { setBusy(false); return; }
    let active = true;
    let worker: Worker | undefined;
    let deadline: number | undefined;
    setBusy(true); setPreview(null); setError('');
    const stop = () => { worker?.terminate(); window.clearTimeout(deadline); };
    const fail = (message: string) => {
      if (!active) return;
      active = false; stop(); setError(message); setBusy(false);
    };
    // Debounce edits; transfer a copy so cancellation never damages the original.
    const timer = window.setTimeout(() => {
      try {
        worker = new Worker(new URL('./pixelSnap.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<PixelSnapResponse>) => {
          if (!active) return;
          if (data.error !== undefined) { fail(data.error); return; }
          try {
            const next = encodePreview(data.result, key);
            active = false; stop(); setPreview(next); setBusy(false);
          } catch (cause) { fail(cause instanceof Error ? cause.message : '无法生成预览。'); }
        };
        worker.onerror = event => { event.preventDefault(); fail('像素处理线程出错，请重试。'); };
        worker.onmessageerror = () => fail('无法读取处理结果，请重试。');
        const pixels = new Uint8ClampedArray(source.pixels.data);
        const options: PixelSnapOptions = { cellSize: pixelSize, avoidOverRefining: avoidRefining, paletteMode,
          paletteSize: paletteMode === 'custom' ? paletteSize : 64, upscale };
        const request: PixelSnapRequest = { source: { ...source.pixels, data: pixels }, options };
        worker.postMessage(request, [pixels.buffer]);
        deadline = window.setTimeout(() => fail('本地处理超过两分钟，可缩小原图或手动指定像素格后重试。'), PREVIEW_TIMEOUT);
      } catch { fail('浏览器无法启动本地处理线程，请刷新后重试。'); }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); stop(); };
  }, [source, sourceMatches, pixelSize, avoidRefining, paletteMode, paletteSize, upscale, invalidPalette, key]);

  const current = sourceMatches && !invalidPalette && preview?.key === key ? preview : null;
  const displayError = invalidPalette ? '颜色数请输入 1–256 的整数。' : error;
  const status = displayError || (busy ? '正在识别网格并整理颜色…' : current ?
    (!current.confident && pixelSize === 0 ? '未识别到稳定的像素网格，保留原尺寸；可在高级设置中手动指定。' : '预览已更新，可下载或应用。') : '正在读取原图…');

  return (
    <div className="modal-backdrop">
      <section ref={dialogRef} className="local-pixel-snap" role="dialog" aria-modal="true" aria-labelledby="pixel-snap-title"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
          if (event.key !== 'Tab') return;
          const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary') || [])
            .filter(element => element.getClientRects().length > 0);
          const first = items[0], last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <header className="local-pixel-snap-header">
          <div><small>PIXEL SNAP</small><h2 id="pixel-snap-title">像素整理</h2></div>
          <button type="button" onClick={onCancel} aria-label="关闭像素整理" autoFocus><X size={18} /></button>
        </header>
        <p className="local-pixel-snap-disclosure">整理像素画的网格与颜色。在浏览器本地处理，不消耗积分。</p>
        <div className="local-pixel-snap-body">
          <aside className="local-pixel-snap-controls">
            <span id="pixel-palette-label">调色板</span>
            <div className="local-pixel-snap-palette" role="group" aria-labelledby="pixel-palette-label">
              {([['off', '关闭'], ['auto', '自动'], ['custom', '自定']] as const).map(([value, label]) =>
                <button key={value} type="button" aria-pressed={paletteMode === value} onClick={() => setPaletteMode(value)}>{label}</button>)}
            </div>
            {paletteMode === 'custom' && <label className="local-pixel-snap-count" htmlFor="local-palette-count">
              最多颜色数
              <input id="local-palette-count" type="number" min={1} max={256} step={1} value={paletteCount} aria-invalid={invalidPalette}
                onChange={event => setPaletteCount(event.target.value)} />
              <small>1–256 色，透明度单独保留。</small>
            </label>}
            {paletteMode === 'auto' && <small>根据颜色差异自动合并相近颜色。</small>}
            {paletteMode === 'off' && <small>保留每个像素格提取出的颜色。</small>}
            <label className="local-pixel-snap-check">
              <input type="checkbox" checked={avoidRefining} disabled={pixelSize > 0} onChange={event => setAvoidRefining(event.target.checked)} />避免过度细化
            </label>
            <small>{pixelSize > 0 ? '手动指定的像素格保持不变。' : avoidRefining ? '保留检测出的像素格大小。' : '更细的网格能明显改善还原效果时，使用更细的网格。'}</small>
            <label className="local-pixel-snap-check">
              <input type="checkbox" checked={upscale} onChange={event => setUpscale(event.target.checked)} />放大
            </label>
            <small>{upscale ? '按整数倍放大，保持像素边缘清晰，尺寸可能与原图略有不同。' : '保留整理后的像素网格尺寸。'}</small>
            <details className="local-pixel-snap-advanced">
              <summary>高级设置</summary>
              <label htmlFor="local-pixel-size">像素格大小</label>
              <select id="local-pixel-size" value={pixelSize} onChange={event => setPixelSize(Number(event.target.value))}>
                <option value={0}>自动识别</option>
                {Array.from({ length: 24 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 像素</option>)}
              </select>
              <small>自动识别不合适时，可指定原图每格的像素数。</small>
            </details>
          </aside>
          <div className="local-pixel-snap-previews">
            <figure><div className="local-pixel-snap-image">{sourceMatches && <img src={source.url} alt="整理前的原图" />}</div>
              <figcaption>原图 · {width} × {height}</figcaption></figure>
            <figure><div className="local-pixel-snap-image" aria-busy={busy}>
              {current && <img src={current.url} alt="像素整理预览" />}
              {!current && <span>{displayError || (busy ? '正在整理像素…' : '正在载入图片…')}</span>}
            </div><figcaption>{current ?
              `预览 · ${current.width} × ${current.height} · ${Number(current.pitch.toFixed(2))} 像素/格${paletteMode !== 'off' ? ` · ${current.paletteSize} 色` : ''}${current.scale > 1 ? ` · ${current.scale} 倍放大` : ''}` : '预览'}</figcaption></figure>
          </div>
        </div>
        <footer className="local-pixel-snap-footer">
          <span role="status">{status}</span>
          {error && sourceMatches && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" disabled={!current || busy} onClick={() => {
            if (!current) return;
            const link = document.createElement('a'); link.href = current.url; link.download = 'pixel-snap.png'; link.click();
          }}><Download size={16} />下载 PNG</button>
          <button type="button" className="local-pixel-snap-save" disabled={!current || busy}
            onClick={() => { if (current) onSave({ data: current.data, width: current.width, height: current.height }); }}><Check size={16} />{saveLabel}</button>
        </footer>
      </section>
    </div>
  );
}
