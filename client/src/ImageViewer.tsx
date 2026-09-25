import { useEffect, useRef, useState } from 'react';
import type { LocalImage } from './types';
import { download } from './storage';

export default function ImageViewer({row, rows, onSelect, onClose}: {
  row: LocalImage; rows: LocalImage[]; onSelect: (id:string)=>void; onClose:()=>void;
}) {
  const [url, setUrl] = useState(''), [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({x:0,y:0});
  const drag = useRef<{x:number;y:number;px:number;py:number} | undefined>(undefined);
  const index = rows.findIndex(item => item.id === row.id);
  useEffect(() => {
    const value = URL.createObjectURL(row.blob); setUrl(value); setZoom(1); setPan({x:0,y:0});
    return () => URL.revokeObjectURL(value);
  }, [row.id, row.blob]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label="查看原图">
    <header>
      <button onClick={onClose}>返回</button>
      <button disabled={index <= 0} onClick={()=>onSelect(rows[index-1].id)}>上一张</button>
      <span>{index+1} / {rows.length}</span>
      <button disabled={index < 0 || index >= rows.length-1} onClick={()=>onSelect(rows[index+1].id)}>下一张</button>
      <button aria-label="缩小图片" onClick={()=>setZoom(value=>Math.max(.25,value/1.25))}>−</button>
      <button onClick={()=>{setZoom(1);setPan({x:0,y:0});}}>{Math.round(zoom*100)}% · 适应</button>
      <button aria-label="放大图片" onClick={()=>setZoom(value=>Math.min(8,value*1.25))}>＋</button>
      <button onClick={()=>download(row.blob,row.result.filename)}>下载原图</button>
    </header>
    <div className="image-viewer-stage" onWheel={e=>setZoom(value=>Math.max(.25,Math.min(8,value*(e.deltaY<0?1.1:1/1.1))))}
      onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};}}
      onPointerMove={e=>{if(drag.current)setPan({x:drag.current.px+e.clientX-drag.current.x,y:drag.current.py+e.clientY-drag.current.y});}}
      onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
      {url && <img draggable={false} src={url} alt="查看原图" style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}/>}
    </div>
  </div>;
}
