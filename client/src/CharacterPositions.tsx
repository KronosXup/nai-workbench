import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent } from 'react';
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
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
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
  function position(x: number, y: number, character = selected) {
    if (!character) return;
    const limit = (value: number) => Math.min(1, Math.max(0, value));
    const coordinate = (value: number) => freePosition ? Math.round(limit(value) * 1000) / 1000 : (Math.min(4, Math.floor(limit(value) * 5)) + .5) / 5;
    onChange(characters.map(c => c === character ? { ...c, x: coordinate(x), y: coordinate(y) } : c));
  }
  function point(event: PointerEvent<HTMLElement>, character = selected) {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    position((event.clientX - box.left) / box.width - (drag.current?.offsetX ?? 0),
      (event.clientY - box.top) / box.height - (drag.current?.offsetY ?? 0), character);
  }
  function startDrag(event: PointerEvent<HTMLElement>, character = selected, preserveOffset = false) {
    if (event.button !== 0 || !character || drag.current) return;
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    if (!box.width || !box.height) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(character.ui_id);
    // A marker owns its drag, even when another character was selected before
    // pointerdown. Keep the grab offset so grabbing its edge does not move it.
    drag.current = { pointerId: event.pointerId,
      offsetX: preserveOffset ? (event.clientX - box.left) / box.width - character.x : 0,
      offsetY: preserveOffset ? (event.clientY - box.top) / box.height - character.y : 0 };
    if (!preserveOffset) point(event, character);
  }
  function moveDrag(event: PointerEvent<HTMLElement>, character = selected) {
    if (drag.current?.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) point(event, character);
  }
  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function moveWithKeyboard(event: ReactKeyboardEvent<HTMLElement>, character = selected) {
    if (!character || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    setSelectedId(character.ui_id);
    const step = freePosition ? (event.shiftKey ? .1 : .01) : .2;
    position(character.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      character.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), character);
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
      <div className="nai-position-canvas" ref={canvas} style={{ width: displayWidth, height: displayHeight }}>
        {freePosition ? <div className="nai-position-free" role="slider" tabIndex={0} aria-label="角色画面位置"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((selected?.x ?? .5) * 100)}
          aria-valuetext={`横向 ${Math.round((selected?.x ?? .5) * 100)}%，纵向 ${Math.round((selected?.y ?? .5) * 100)}%`}
          onPointerDown={event => startDrag(event)} onPointerMove={event => moveDrag(event)}
          onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
          onKeyDown={event => moveWithKeyboard(event)} /> : <div className="nai-position-cells">
          {Array.from({ length: 25 }, (_, index) => {
            const x = ((index % 5) + .5) / 5, y = (Math.floor(index / 5) + .5) / 5;
            return <button key={index} aria-label={`第 ${Math.floor(index / 5) + 1} 行第 ${index % 5 + 1} 列`} disabled={!selected}
              aria-pressed={!!selected && Math.abs(selected.x - x) < .001 && Math.abs(selected.y - y) < .001}
              onClick={() => position(x, y)} />;
          })}
        </div>}
        <div className="nai-position-guides" aria-hidden="true">{lines.map(at => <span key={at}><i style={{ left: `${at * 100}%` }} /><b style={{ top: `${at * 100}%` }} /></span>)}</div>
        {enabled.map(c => <button type="button" key={c.ui_id} className={`nai-position-marker${c === selected ? ' selected' : ''}`}
          aria-label={`拖动 ${c.name || `角色 ${characters.indexOf(c) + 1}`} 的位置`} aria-pressed={c === selected}
          title={`${c.name || `角色 ${characters.indexOf(c) + 1}`}：拖动调整位置`}
          onPointerDown={event => startDrag(event, c, true)} onPointerMove={event => moveDrag(event, c)}
          onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
          onClick={() => setSelectedId(c.ui_id)} onKeyDown={event => moveWithKeyboard(event, c)}
          style={{ left: `${Math.min(1, Math.max(0, c.x)) * 100}%`, top: `${Math.min(1, Math.max(0, c.y)) * 100}%` }}>{characters.indexOf(c) + 1}</button>)}
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
