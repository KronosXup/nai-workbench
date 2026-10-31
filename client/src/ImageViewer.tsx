import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LocalImage } from './types';
import { downloadImage } from './storage';

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pan'; pointerId: number; start: Point; pan: Point }
  | { kind: 'pinch'; pointerIds: [number, number]; distance: number; zoom: number; pan: Point; center: Point };

const clampZoom = (value: number) => Math.max(.25, Math.min(8, value));

export default function ImageViewer({row, rows, onSelect, onClose}: {
  row: LocalImage; rows: LocalImage[]; onSelect: (id:string)=>void; onClose:()=>void;
}) {
  const [url, setUrl] = useState(''), [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({x:0,y:0});
  const [showPrompts, setShowPrompts] = useState(true);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarId = `image-prompts-${row.id}`;
  const zoomRef = useRef(1), panRef = useRef<Point>({x:0,y:0});
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | undefined>(undefined);
  const index = rows.findIndex(item => item.id === row.id);
  const receipt = row.result.metadata.gate_receipt;

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar || !showPrompts) return;
    const fitFields = () => {
      const scrollTop = sidebar.scrollTop;
      sidebar.querySelectorAll('textarea').forEach(field => {
        field.style.height = '0px';
        field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
      });
      sidebar.scrollTop = scrollTop;
    };
    const observer = new ResizeObserver(fitFields);
    observer.observe(sidebar);
    fitFields();
    return () => observer.disconnect();
  }, [row.id, showPrompts]);

  const changeZoom = (next: number) => {
    const value = clampZoom(next);
    zoomRef.current = value;
    setZoom(value);
  };
  const changePan = (next: Point) => {
    panRef.current = next;
    setPan(next);
  };
  const clearPointers = () => {
    const stage = stageRef.current;
    const activeIds = [...pointers.current.keys()];
    pointers.current.clear();
    gesture.current = undefined;
    activeIds.forEach(id => {
      if (stage?.hasPointerCapture(id)) stage.releasePointerCapture(id);
    });
  };
  const resetView = () => {
    clearPointers();
    changeZoom(1);
    changePan({x:0,y:0});
  };

  useEffect(() => {
    const value = URL.createObjectURL(row.blob);
    setUrl(value);
    pointers.current.clear();
    gesture.current = undefined;
    zoomRef.current = 1;
    panRef.current = {x:0,y:0};
    setZoom(1);
    setPan({x:0,y:0});
    return () => {
      URL.revokeObjectURL(value);
      clearPointers();
    };
  // IndexedDB returns a new Blob object on every gallery refresh. Reset only
  // when the selected image or its content changes, not during background polls.
  }, [row.id, row.result.sha256]);

  const stageCenter = (point: Point): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? {x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2} : point;
  };
  const midpoint = (a: Point, b: Point) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const distance = (a: Point, b: Point) => Math.hypot(b.x-a.x,b.y-a.y);
  const startPan = (pointerId: number, point: Point) => {
    gesture.current = {kind:'pan', pointerId, start:point, pan:panRef.current};
  };
  const startPinch = (ids: [number, number]) => {
    const a = pointers.current.get(ids[0]);
    const b = pointers.current.get(ids[1]);
    if (!a || !b) return;
    gesture.current = {
      kind:'pinch', pointerIds:ids, distance:Math.max(1,distance(a,b)),
      zoom:zoomRef.current, pan:panRef.current, center:stageCenter(midpoint(a,b)),
    };
  };
  const updateGesture = () => {
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') {
      const point = pointers.current.get(current.pointerId);
      if (point) changePan({x:current.pan.x+point.x-current.start.x,y:current.pan.y+point.y-current.start.y});
      return;
    }
    const a = pointers.current.get(current.pointerIds[0]);
    const b = pointers.current.get(current.pointerIds[1]);
    if (!a || !b) return;
    const nextZoom = clampZoom(current.zoom * distance(a,b) / current.distance);
    const center = stageCenter(midpoint(a,b));
    // Keep the image point under the fingers anchored while the pinch center moves.
    const imagePoint = {x:(current.center.x-current.pan.x)/current.zoom,y:(current.center.y-current.pan.y)/current.zoom};
    changeZoom(nextZoom);
    changePan({x:center.x-imagePoint.x*nextZoom,y:center.y-imagePoint.y*nextZoom});
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (pointers.current.has(event.pointerId) || pointers.current.size >= 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if (pointers.current.size === 1) startPan(event.pointerId,{x:event.clientX,y:event.clientY});
    else startPinch([...pointers.current.keys()] as [number,number]);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    updateGesture();
  };
  const finishPointer = (pointerId: number, finalPoint?: Point) => {
    if (!pointers.current.has(pointerId)) return;
    if (finalPoint) {
      pointers.current.set(pointerId,finalPoint);
      updateGesture();
    }
    pointers.current.delete(pointerId);
    const remaining = [...pointers.current.entries()];
    if (remaining.length === 1) startPan(remaining[0][0],remaining[0][1]);
    else if (remaining.length === 2) startPinch([remaining[0][0],remaining[1][0]]);
    else gesture.current = undefined;
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointer(event.pointerId,{x:event.clientX,y:event.clientY});
  };
  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishPointer(event.pointerId);
  };

  return <div className="lightbox" role="dialog" aria-modal="true" aria-label="查看原图">
    <header>
      <button onClick={onClose}>返回</button>
      <button disabled={index <= 0} onClick={()=>onSelect(rows[index-1].id)}>上一张</button>
      <span>{index+1} / {rows.length}</span>
      <button disabled={index < 0 || index >= rows.length-1} onClick={()=>onSelect(rows[index+1].id)}>下一张</button>
      <button aria-label="缩小图片" onClick={()=>changeZoom(zoomRef.current/1.25)}>−</button>
      <button onClick={resetView}>{Math.round(zoom*100)}% · 适应</button>
      <button aria-label="放大图片" onClick={()=>changeZoom(zoomRef.current*1.25)}>＋</button>
      <button aria-expanded={showPrompts} aria-controls={sidebarId} onClick={()=>setShowPrompts(value=>!value)}>
        {showPrompts ? '收起提示词' : '显示提示词'}
      </button>
      <button onClick={()=>downloadImage(row)}>下载原图</button>
    </header>
    <div className="image-viewer-body">
    <aside ref={sidebarRef} id={sidebarId} className="image-viewer-sidebar" aria-label="图片提示词与生成详情" hidden={!showPrompts}>
    <details className="image-execution-details" key={row.id}>
      <summary>生成详情</summary>
      {receipt ? <>
        <p>Gate 记账：{receipt.cost.anlas} Anlas · {receipt.cost.v5} V5 额度
          {receipt.cost.legacy_free_images > 0 && ` · 普通免费 ${receipt.cost.legacy_free_images} 张`}</p>
        <small>本次图像处理的 Gate 记录；不含单独的 Vibe 编码费用。</small>
        <table><thead><tr><th>参数</th><th>请求</th><th>实际执行</th></tr></thead><tbody>
          <tr><th>模型</th><td>{row.job.model}</td><td>{receipt.model ?? '—'}</td></tr>
          {([['width','宽度'],['height','高度'],['steps','步数'],['sampler','采样器'],['seed','种子'],
            ['scale','提示词引导'],['cfg_rescale','Rescale'],['strength','强度'],['noise','噪声']] as const)
            .filter(([key]) => receipt.parameters[key] !== undefined || row.job.parameters[key] !== undefined)
            .map(([key,label]) => <tr key={key}><th>{label}</th><td>{String(row.job.parameters[key] ?? '—')}</td>
              <td>{String(receipt.parameters[key] ?? '—')}</td></tr>)}
        </tbody></table>
        <p>完成 {receipt.completed_images} 张 · 本图 {String(row.result.metadata.width)} × {String(row.result.metadata.height)}</p>
      </> : <p>这张图片没有 Gate 执行回执。</p>}
    </details>
    <section className="image-execution-details image-prompt-details" key={`prompts:${row.id}`}>
      <h2>图片提示词</h2><small>可选择部分文字复制</small>
      <label>正面提示词<textarea aria-label="图片正面提示词" readOnly rows={3} value={row.job.prompt} /></label>
      <label>负面提示词<textarea aria-label="图片负面提示词" readOnly rows={2} value={row.job.negative_prompt} /></label>
      {(row.job.parameters.character_prompts ?? []).filter(character => character.enabled !== false).map((character, index) => <div key={index}>
        <label>角色 {index + 1} 正面<textarea aria-label={`角色 ${index + 1} 正面提示词`} readOnly rows={2} value={character.prompt} /></label>
        {character.negative_prompt && <label>角色 {index + 1} 负面<textarea aria-label={`角色 ${index + 1} 负面提示词`} readOnly rows={2} value={character.negative_prompt} /></label>}
      </div>)}
    </section>
    </aside>
    <div ref={stageRef} className="image-viewer-stage"
      onWheel={e=>changeZoom(zoomRef.current*(e.deltaY<0?1.1:1/1.1))}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handleLostPointerCapture}
      onLostPointerCapture={handleLostPointerCapture}>
      {url && <img draggable={false} src={url} alt="查看原图" style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}/>}
    </div>
    </div>
  </div>;
}
