import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Grid2X2 } from 'lucide-react';
import type { CharacterPrompt } from './types';
import './characterPositions.css';

type Props = {
  characters: CharacterPrompt[];
  width: number;
  height: number;
  model: string;
  onChange: (characters: CharacterPrompt[]) => void;
  onClose: () => void;
};

export default function CharacterPositions({ characters, width, height, model, onChange, onClose }: Props) {
  const freePosition = model.startsWith('nai-diffusion-5');
  const enabled = characters.filter(c => c.enabled !== false);
  const [selectedId, setSelectedId] = useState(enabled[0]?.ui_id);
  const selected = enabled.find(c => c.ui_id === selectedId) ?? enabled[0];
  const [guides, setGuides] = useState<'none' | 'thirds' | 'phi' | 'grid'>('none');
  const [guideMenu, setGuideMenu] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 500, height: 500 });
  const finish = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    finish.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const ratio = Math.max(1, width) / Math.max(1, height);
  const displayWidth = Math.max(1, Math.min(available.width, available.height * ratio));
  const displayHeight = displayWidth / ratio;
  function position(x: number, y: number) {
    if (!selected) return;
    onChange(characters.map(c => c === selected ? { ...c, x, y } : c));
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    position(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)));
  }
  const lines = guides === 'thirds' ? [1 / 3, 2 / 3] : guides === 'phi' ? [.382, .618] : guides === 'grid' ? [.2, .4, .6, .8] : [];
  return <section className="nai-character-positions" aria-label="角色位置编辑器">
    <div className="nai-position-characters" aria-label="选择定位角色">
      {enabled.map(c => {
        const number = characters.indexOf(c) + 1;
        return <button key={c.ui_id ?? number} aria-label={`定位 ${c.name || `角色 ${number}`}`} aria-pressed={c === selected} onClick={() => setSelectedId(c.ui_id)}>
          {number} <span aria-hidden="true">{c.gender === 'female' ? '♀' : c.gender === 'male' ? '♂' : '◇'}</span>
        </button>;
      })}
    </div>
    <div className="nai-position-area" ref={area}>
      <div className="nai-position-canvas" style={{ width: displayWidth, height: displayHeight }}>
        {freePosition ? <div className="nai-position-free" role="slider" tabIndex={0} aria-label="角色画面位置"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((selected?.x ?? .5) * 100)}
          aria-valuetext={`横向 ${Math.round((selected?.x ?? .5) * 100)}%，纵向 ${Math.round((selected?.y ?? .5) * 100)}%`}
          onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); point(event); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={event => {
            if (!selected || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? .1 : .01;
            position(Math.min(1, Math.max(0, selected.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))),
              Math.min(1, Math.max(0, selected.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))));
          }} /> : <div className="nai-position-cells">
          {Array.from({ length: 25 }, (_, index) => {
            const x = ((index % 5) + .5) / 5, y = (Math.floor(index / 5) + .5) / 5;
            return <button key={index} aria-label={`第 ${Math.floor(index / 5) + 1} 行第 ${index % 5 + 1} 列`} disabled={!selected}
              aria-pressed={!!selected && Math.abs(selected.x - x) < .001 && Math.abs(selected.y - y) < .001}
              onClick={() => position(x, y)} />;
          })}
        </div>}
        <div className="nai-position-guides" aria-hidden="true">{lines.map(at => <span key={at}><i style={{ left: `${at * 100}%` }} /><b style={{ top: `${at * 100}%` }} /></span>)}</div>
        {enabled.map(c => <span key={c.ui_id} className={`nai-position-marker${c === selected ? ' selected' : ''}`} aria-hidden="true"
          style={{ left: `${Math.min(1, Math.max(0, c.x)) * 100}%`, top: `${Math.min(1, Math.max(0, c.y)) * 100}%` }}>{characters.indexOf(c) + 1}</span>)}
      </div>
    </div>
    <footer>
      <div className="nai-position-guide-menu">
        <button aria-label="构图辅助线" aria-expanded={guideMenu} onClick={() => setGuideMenu(!guideMenu)}><Grid2X2 size={18} /></button>
        {guideMenu && <div aria-label="辅助线类型">{([['none', '无'], ['thirds', '三分线'], ['phi', '黄金分割'], ['grid', '网格']] as const).map(([value, text]) =>
          <button key={value} aria-pressed={guides === value} onClick={() => setGuides(value)}>{text}</button>)}</div>}
      </div>
      {!selected && <span>请先启用一个角色</span>}
      <button ref={finish} className="nai-finish-positions" onClick={onClose}>完成位置编辑</button>
    </footer>
  </section>;
}
