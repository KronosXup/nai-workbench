import { useEffect, useRef, useState } from 'react';
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
  const zoomRef = useRef(1), panRef = useRef<Point>({x:0,y:0});
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | undefined>(undefined);
  const index = rows.findIndex(item => item.id === row.id);

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
      <button onClick={()=>downloadImage(row)}>下载原图</button>
    </header>
    <div ref={stageRef} className="image-viewer-stage"
      onWheel={e=>changeZoom(zoomRef.current*(e.deltaY<0?1.1:1/1.1))}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handleLostPointerCapture}
      onLostPointerCapture={handleLostPointerCapture}>
      {url && <img draggable={false} src={url} alt="查看原图" style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}/>}
    </div>
  </div>;
}
