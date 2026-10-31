import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
import type { Job, LocalImage } from './types';
import type { CanvasTransparencyBackground } from './CanvasToolbar';
import CanvasBackdrop from './CanvasBackdrop';
import { Download, FileText } from 'lucide-react';
import { downloadImage } from './storage';
import { GenerationPlaceholder } from './GenerationFeedback';
import { canvasRectsIntersect, canvasVisibleRect, layoutCanvasItems } from './outputCanvasGeometry';
import type { CanvasCamera, CanvasRect } from './outputCanvasGeometry';
import useOutputCamera from './useOutputCamera';
import './outputCanvas.css';

type Preview = { image: string; media_type: string; step?: number };
type Source = { image: string; width: number; height: number };
type Props = {
  rows: LocalImage[];
  selected?: LocalImage;
  liveJob?: Job;
  preview?: Preview;
  focusLive: boolean;
  blank: boolean;
  focusRevision: number;
  source?: Source;
  compareSource?: Source;
  allowUpscale: boolean;
  transparencyBackground: CanvasTransparencyBackground;
  onSelect: (row: LocalImage) => void;
  onInspect: (row: LocalImage) => void;
  onShowLive: () => void;
  onReady: (id: string) => void;
  renderImage: (row: LocalImage) => ReactNode;
};
type LoadState = 'ready' | 'failed';
const contains = (rect: CanvasRect, point: { x: number; y: number }) =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
const contentKey = (row: LocalImage) => `${row.id}:${row.result.sha256}`;
const imageSize = (row: LocalImage) => ({
  width: typeof row.result.metadata.width === 'number' && Number.isFinite(row.result.metadata.width) && row.result.metadata.width > 0 ? row.result.metadata.width : row.job.parameters.width,
  height: typeof row.result.metadata.height === 'number' && Number.isFinite(row.result.metadata.height) && row.result.metadata.height > 0 ? row.result.metadata.height : row.job.parameters.height,
});

const CanvasImage = memo(function CanvasImage({ row, renderImage, onStatus, onUnload }: {
  row: LocalImage; renderImage: Props['renderImage'];
  onStatus: (key: string, status: LoadState) => void; onUnload: (key: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const key = contentKey(row);
  // Gallery polling returns new Blob objects for unchanged image content.
  const blob = useMemo(() => row.blob, [row.id, row.result.sha256]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setFailed(false); setReady(false);
    if (!row.result.media_type.startsWith('image/')) { setReady(true); onStatus(key, 'ready'); return () => onUnload(key); }
    const image = frame.current?.querySelector('img');
    if (image?.complete && image.naturalWidth > 0) { setReady(true); onStatus(key, 'ready'); }
    return () => onUnload(key);
  }, [key, onStatus, onUnload]);
  const loaded = (event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLImageElement) || !event.target.naturalWidth) return;
    setReady(true); setFailed(false); onStatus(key, 'ready');
  };
  const error = (event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLImageElement) || !event.target.getAttribute('src')) return;
    setFailed(true); onStatus(key, 'failed');
  };
  return <div ref={frame} className={`nai-world-image${ready ? ' is-ready' : ''}`} onLoadCapture={loaded} onErrorCapture={error}>
    {!ready && !failed && <span className="nai-world-image-loading" aria-label="图片加载中" />}
    {!failed && <Fragment key={key}>{renderImage({ ...row, blob })}</Fragment>}
    {failed && <span className="nai-world-image-error" role="alert">图片加载失败</span>}
  </div>;
});

export default function OutputCanvas(p: Props) {
  const viewportRef = useRef<HTMLDivElement>(null), worldRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Map<string, LoadState>());
  const [readyVersion, setReadyVersion] = useState(0);
  const onStatus = useCallback((key: string, status: LoadState) => {
    if (loaded.current.get(key) === status) return;
    loaded.current.set(key, status); setReadyVersion(value => value + 1);
  }, []);
  const onUnload = useCallback((key: string) => { loaded.current.delete(key); }, []);
  const imageRenderer = useRef(p.renderImage);
  imageRenderer.current = p.renderImage;
  const renderImage = useCallback((row: LocalImage) => imageRenderer.current(row), []);
  const rows = p.blank || p.source ? [] : [...p.rows];
  if (!p.blank && !p.source && p.selected && !rows.some(row => row.id === p.selected!.id)) rows.unshift(p.selected);
  const byId = new Map(rows.map(row => [row.id, row]));
  const liveId = !p.blank && !p.source && p.liveJob && !rows.some(row => row.job.id === p.liveJob!.id) ? `live:${p.liveJob.id}` : undefined;
  const items = rows.map(row => ({ id: row.id, ...imageSize(row) }));
  if (liveId && p.liveJob) items.unshift({ id: liveId, width: p.liveJob.parameters.width, height: p.liveJob.parameters.height });
  const layoutKey = items.map(item => `${item.id}:${item.width}:${item.height}`).join('|');
  const placements = useMemo(() => layoutCanvasItems(items), [layoutKey]);
  const focusId = p.source ? 'source' : p.blank ? 'empty' : p.focusLive && liveId ? liveId : p.selected?.id ?? 'empty';
  const focused = placements.find(item => item.id === focusId);
  const sourceRect: CanvasRect | undefined = p.source ? { x: -p.source.width / 2, y: 0, width: p.source.width, height: p.source.height }
    : p.compareSource && focused ? { x: focused.x - p.compareSource.width - 120,
      y: focused.y + (focused.height - p.compareSource.height) / 2, width: p.compareSource.width, height: p.compareSource.height } : undefined;
  const emptyRect = { x: -600, y: -450, width: 1200, height: 900 };
  const targetRect: CanvasRect = p.source ? sourceRect! : focused && sourceRect ? {
    x: sourceRect.x, y: Math.min(sourceRect.y, focused.y), width: focused.x + focused.width - sourceRect.x,
    height: Math.max(sourceRect.y + sourceRect.height, focused.y + focused.height) - Math.min(sourceRect.y, focused.y),
  } : focused ?? emptyRect;
  const targetSignature = `${targetRect.x}:${targetRect.y}:${targetRect.width}:${targetRect.height}`;
  const content = [...placements, ...(sourceRect ? [sourceRect] : [])];
  const left = content.length ? Math.min(...content.map(rect => rect.x)) : emptyRect.x;
  const top = content.length ? Math.min(...content.map(rect => rect.y)) : emptyRect.y;
  const bounds = content.length ? { x: left, y: top,
    width: Math.max(...content.map(rect => rect.x + rect.width)) - left,
    height: Math.max(...content.map(rect => rect.y + rect.height)) - top } : emptyRect;
  const camera = useOutputCamera({ viewportRef, worldRef, bounds, allowUpscale: p.allowUpscale,
    onTap: (point, current: CanvasCamera) => {
      const at = { x: (point.x - current.x) / current.scale, y: (point.y - current.y) / current.scale };
      const hit = placements.find(item => contains(item, at));
      if (hit?.id === liveId) p.onShowLive();
      else if (hit && byId.has(hit.id)) p.onSelect(byId.get(hit.id)!);
    },
  });
  const lastFocus = useRef<{ id: string; revision: number; signature: string; job?: string } | undefined>(undefined);
  const currentJobId = focusId === liveId ? p.liveJob?.id : p.selected?.job.id;
  const targetStatus = p.selected && focusId === p.selected.id ? loaded.current.get(contentKey(p.selected)) : undefined;
  useLayoutEffect(() => {
    if (!camera.viewport.width || !camera.viewport.height) return;
    if (p.selected && focusId === p.selected.id && !targetStatus) return;
    const previous = lastFocus.current;
    if (previous?.id === focusId && previous.revision === p.focusRevision && previous.signature === targetSignature) return;
    const completingLive = previous?.id.startsWith('live:') && previous.job === currentJobId && previous.signature === targetSignature && previous.revision === p.focusRevision;
    if (!completingLive) camera.fit(targetRect, Boolean(previous && previous.id !== 'empty' && previous.id !== 'source' && focusId !== 'empty' && focusId !== 'source'));
    lastFocus.current = { id: focusId, revision: p.focusRevision, signature: targetSignature, job: currentJobId };
  }, [focusId, p.focusRevision, targetSignature, targetStatus, camera.viewport.width, camera.viewport.height, camera.fit]);
  useEffect(() => {
    if (p.selected && !p.focusLive && !p.blank && !p.source && loaded.current.get(contentKey(p.selected)) === 'ready') p.onReady(p.selected.id);
    else if (p.selected && !p.liveJob && !p.blank && !p.source && loaded.current.get(contentKey(p.selected)) === 'ready') p.onReady(p.selected.id);
  }, [p.selected?.id, p.selected?.result.sha256, p.focusLive, p.blank, p.source, p.liveJob?.id, readyVersion]);
  const visible = canvasVisibleRect(camera.camera, camera.viewport);
  const visiblePlacements = placements.filter(item => item.id === focusId || canvasRectsIntersect(item, visible, 300 / camera.camera.scale));
  const backdrop = (rect: CanvasRect, identity: string) => <div className="nai-world-decoration"
    style={{ left: rect.x - 360, top: rect.y - 260, width: rect.width + 720, height: rect.height + 520 }}><CanvasBackdrop identity={identity} /></div>;
  const reset = () => camera.fit(targetRect);

  return <div ref={viewportRef} className={`nai-output-viewport${camera.dragging ? ' is-dragging' : ''}`}
    tabIndex={0} role="region" aria-label="结果画布" data-transparency={p.transparencyBackground}
    {...camera.handlers} onDragStart={event => event.preventDefault()}
    onDoubleClick={() => { if (!camera.wasDrag.current) reset(); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      const center = { x: camera.viewport.width / 2, y: camera.viewport.height / 2 };
      if (event.key === '+' || event.key === '=') { event.preventDefault(); camera.zoomAt(center, camera.camera.scale * 1.2); }
      else if (event.key === '-') { event.preventDefault(); camera.zoomAt(center, camera.camera.scale / 1.2); }
      else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); reset(); }
      else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
        event.preventDefault(); camera.panBy(event.key === 'ArrowLeft' ? 48 : event.key === 'ArrowRight' ? -48 : 0,
          event.key === 'ArrowUp' ? 48 : event.key === 'ArrowDown' ? -48 : 0);
      }
    }}>
    <div ref={worldRef} className="nai-output-world" style={{ '--output-scale': camera.camera.scale,
      visibility: p.selected && focusId === p.selected.id && !targetStatus && (!lastFocus.current || lastFocus.current.id === 'empty') ? 'hidden' : undefined } as CSSProperties}>
      {focusId === 'empty' && backdrop(emptyRect, 'empty')}
      {visiblePlacements.map(item => {
        const row = byId.get(item.id);
        const live = item.id === liveId;
        return <div key={item.id} className={`nai-world-entry${item.id === focusId ? ' is-selected' : ''}`}
          style={{ left: item.x, top: item.y, width: item.width, height: item.height }}>
          <div className="nai-world-local-decoration"><CanvasBackdrop identity={live ? p.liveJob!.id : row!.job.id} /></div>
          {live ? <div className="nai-world-image is-ready">
            {p.preview ? <img draggable={false} src={`data:${p.preview.media_type};base64,${p.preview.image}`} alt="生成中的临时预览" />
              : <GenerationPlaceholder width={item.width} height={item.height} />}
          </div> : row && <div className="nai-world-selectable" role="button" tabIndex={0} aria-label={`查看图片 ${row.id.slice(0,6)}`}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); p.onSelect(row); } }}>
            <CanvasImage row={row} renderImage={renderImage} onStatus={onStatus} onUnload={onUnload} />
          </div>}
          {row && <>
            {item.id === focusId && <span className="nai-world-selection">已选中</span>}
            <div className="nai-world-actions" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
              <button type="button" aria-label={`查看图片提示词 ${row.id.slice(0,6)}`} title="查看这张图的提示词"
                onClick={event => { event.stopPropagation(); p.onInspect(row); }}><FileText /></button>
              <button type="button" aria-label={`下载图片 ${row.id.slice(0,6)}`} title="下载这张图片"
                onClick={event => { event.stopPropagation(); downloadImage(row); }}><Download /></button>
            </div>
          </>}
        </div>;
      })}
      {sourceRect && (p.source || p.compareSource) && <>
        {backdrop(sourceRect, 'source')}
        <div className="nai-world-entry nai-world-source" style={{ left: sourceRect.x, top: sourceRect.y, width: sourceRect.width, height: sourceRect.height }}>
          <div className="nai-world-image is-ready"><img draggable={false} src={`data:image/png;base64,${(p.source ?? p.compareSource)!.image}`} alt="当前源图片" /></div>
        </div>
      </>}
    </div>
    {p.source && <span className="nai-world-caption">当前源图片</span>}
    {!p.source && p.selected?.result.metadata.mock === true && !p.focusLive && <span className="nai-world-caption">模拟输出 · 不是真实生图</span>}
  </div>;
}
