import { useId } from 'react';
import { Sparkles, X } from 'lucide-react';
import './enhancePanel.css';

export type EnhanceSettings = {
  scale: number | 'max';
  magnitude: number;
  strength: number;
  noise: number;
  advanced: boolean;
};

type Props = {
  settings: EnhanceSettings;
  scales: Array<{ value: number | 'max'; label: string; disabled?: boolean; title?: string }>;
  width: number;
  height: number;
  busy: boolean;
  onChange: (patch: Partial<EnhanceSettings>) => void;
  onClose: () => void;
};

const magnitudes = [
  { strength: .2, noise: 0 },
  { strength: .4, noise: 0 },
  { strength: .5, noise: 0 },
  { strength: .6, noise: 0 },
  { strength: .7, noise: .1 },
];

export default function EnhancePanel({ settings, scales, width, height, busy, onChange, onClose }: Props) {
  const id = useId();
  const slider = (key: 'magnitude' | 'strength' | 'noise', label: string, min: number, max: number, step: number) => {
    const update = (value: number) => {
      if (!Number.isFinite(value)) return;
      const next = Math.min(max, Math.max(min, Math.round(value / step) * step));
      if (key === 'magnitude') onChange({ magnitude: next, ...magnitudes[next - 1] });
      else onChange({ [key]: Math.round(next * 100) / 100 });
    };
    return <div className="nai-enhance-setting">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <div className="nai-enhance-setting-inputs">
        <input id={`${id}-${key}`} type="number" min={min} max={max} step={step}
          value={settings[key]} disabled={busy} onChange={event => update(event.currentTarget.valueAsNumber)} />
        <input type="range" aria-label={`${label}滑杆`} min={min} max={max} step={step}
          value={settings[key]} disabled={busy} onChange={event => update(event.currentTarget.valueAsNumber)} />
      </div>
    </div>;
  };

  return <section className="nai-enhance-anchor" aria-labelledby={`${id}-title`}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div className="nai-enhance-panel">
      <header className="nai-enhance-heading">
        <Sparkles size={16} aria-hidden="true" />
        <h2 id={`${id}-title`}>Enhance</h2>
        <button type="button" className="nai-enhance-close" aria-label="关闭 Enhance" title="关闭 Enhance" onClick={onClose}>
          <X size={12} aria-hidden="true" />
        </button>
      </header>
      <div className="nai-enhance-body">
        <fieldset className="nai-enhance-scale" disabled={busy}>
          <legend>放大倍率</legend>
          <div className="nai-enhance-scale-options">
            {scales.map(option => <label className="nai-enhance-scale-option" key={option.value} title={option.title}>
              <input type="radio" name={`${id}-scale`} value={option.value} checked={settings.scale === option.value}
                disabled={option.disabled} onChange={() => onChange({ scale: option.value })} />
              <span>{option.label}{option.value === 'max' && <Sparkles size={11} aria-hidden="true" />}</span>
            </label>)}
          </div>
          <output className="nai-enhance-size" aria-label="增强输出尺寸">{width} × {height}</output>
        </fieldset>
        <div className="nai-enhance-adjustments">
          <div key={String(settings.advanced)} id={`${id}-settings`} className="nai-enhance-sliders">
            {settings.advanced ? <>
              {slider('strength', '强度', .01, .99, .01)}
              {slider('noise', '噪声', 0, .99, .01)}
            </> : slider('magnitude', '变化力度', 1, 5, 1)}
          </div>
          <button type="button" className="nai-enhance-advanced" aria-expanded={settings.advanced}
            aria-controls={`${id}-settings`} disabled={busy} onClick={() => onChange({ advanced: !settings.advanced })}>
            {settings.advanced ? '隐藏高级设置' : '显示高级设置'}
          </button>
        </div>
      </div>
    </div>
  </section>;
}
