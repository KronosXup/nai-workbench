import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, RotateCcw, Sprout, X } from 'lucide-react';
import type { Parameters } from './types';
import NaiSelect from './NaiSelect';
import { defaultNoiseSchedule, modelGenerationDefaults, noiseSchedulesFor, samplersFor, varietySigma } from './modelSettings';
import './advancedSettings.css';

export default function AdvancedSettings({ model, params, patch, onClose, onSampler }: {
  model: string; params: Parameters; patch: (changes: Partial<Parameters>) => void;
  onClose: () => void; onSampler: (value: string) => void;
}) {
  const [more, setMore] = useState(false);
  const v5 = model.startsWith('nai-diffusion-5'), v3 = model.endsWith('-3');
  const samplers = samplersFor(model), schedules = noiseSchedulesFor(model, params.sampler);
  const toggle = (label: string, checked: boolean, onChange: () => void, disabled = false) =>
    <button type="button" className="nai-setting-toggle" role="checkbox" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}>
      {checked ? <Check size={14}/> : <X size={14}/>} {label}
    </button>;
  const flag = (key: string, label: string, disabled = false) => toggle(label, params[key] === true, () => patch({[key]:params[key] !== true}), disabled);
  const slider = (key: string, label: string, fallback: number, min: number, max: number, step: number, accessory?: ReactNode) => {
    const value = Number(params[key] ?? fallback);
    const update = (next: number) => { if (Number.isFinite(next)) patch({[key]:Math.min(max, Math.max(min, next))}); };
    return <div className="nai-setting-slider" key={key}>
      <div className="nai-setting-label"><span>{label}</span>{accessory}</div>
      <div className="nai-setting-controls">
        <input type="number" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => update(e.currentTarget.valueAsNumber)}/>
        <input type="range" aria-label={`${label}滑杆`} min={min} max={max} step={step} value={value} onChange={e => update(e.currentTarget.valueAsNumber)}/>
      </div>
    </div>;
  };
  return <section className="nai-advanced" aria-label="生成参数">
    <header className="nai-settings-heading"><span>生成参数</span>
      <button type="button" title="重置生成参数" aria-label="重置生成参数" onClick={() => patch(modelGenerationDefaults(model))}><RotateCcw size={17}/></button>
      <button type="button" title="收起生成参数" aria-label="收起生成参数" aria-expanded="true" onClick={onClose}><ChevronDown size={18}/></button>
    </header>
    {slider('steps', '步数', 23, 1, 50, 1)}
    {slider('scale', '提示词引导', 5, 0, 20, .1, !v5 && toggle('Variety+', Number(params.skip_cfg_above_sigma) > 0, () => patch({skip_cfg_above_sigma: Number(params.skip_cfg_above_sigma) > 0 ? null : varietySigma(model)})))}
    <div className="nai-settings-pair">
      <label>种子<div className="nai-settings-seed"><input type="number" aria-label="完整种子" min={0} max={4294967295} placeholder="随机" value={params.seed < 0 ? '' : params.seed}
        onChange={e => { const value = e.currentTarget.valueAsNumber; if(e.currentTarget.value === '') patch({seed:-1}); else if(Number.isFinite(value)) patch({seed:Math.min(4294967295,Math.max(0,Math.trunc(value)))}); }}/>
        <button type="button" title="随机种子" aria-label="使用随机种子" onClick={() => patch({seed:-1})}><Sprout size={16}/></button></div></label>
      <label>采样器<NaiSelect ariaLabel="采样器" value={params.sampler} onChange={onSampler} options={[
        ...(!samplers.some(([id]) => id === params.sampler) ? [{value:params.sampler,label:`${params.sampler}（请更换）`,disabled:true}] : []),
        ...samplers.map(([value,label]) => ({value,label})),
      ]}/></label>
    </div>
    <button type="button" className="nai-more-settings" aria-expanded={more} onClick={() => setMore(!more)}>更多参数<ChevronDown size={14} className={more ? 'is-open' : ''}/></button>
    {more && <div className="nai-settings-extra">
      {slider('cfg_rescale','引导重缩放',0,0,1,.01)}
      {!v5 && <label>噪声调度<NaiSelect ariaLabel="噪声调度" value={String(params.noise_schedule ?? defaultNoiseSchedule(params.sampler))} onChange={noise_schedule => patch({noise_schedule})} options={[
        ...schedules.map(value => ({value,label:value})),
        ...(params.noise_schedule && !schedules.includes(String(params.noise_schedule)) ? [{value:String(params.noise_schedule),label:`${params.noise_schedule}（旧设置）`}] : []),
      ]}/></label>}
      {slider('uncond_scale','负面提示词强度',1,0,2,.05)}
      <div className="nai-setting-flags">
        {!v5 && flag('prefer_brownian','Brownian 噪声')}
        {v3 && <>{flag('sm','SMEA')}{flag('sm_dyn','SMEA Dyn',params.sm !== true)}{flag('dynamic_thresholding','Decrisp')}{flag('legacy_v3_extend','旧版 V3 扩展')}</>}
      </div>
    </div>}
  </section>;
}
