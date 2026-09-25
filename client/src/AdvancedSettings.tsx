import type { Parameters } from './types';
import { defaultNoiseSchedule, modelGenerationDefaults, noiseSchedulesFor, varietySigma } from './modelSettings';

export default function AdvancedSettings({ model, params, patch }: {
  model: string; params: Parameters; patch: (changes: Partial<Parameters>) => void;
}) {
  const v5 = model.startsWith('nai-diffusion-5'), v3 = model.endsWith('-3');
  const numeric = (key: string, label: string, fallback: number, min: number, max: number, step: number) =>
    <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step}
      value={Number(params[key] ?? fallback)} onChange={e => { if(e.target.value !== '' && Number.isFinite(+e.target.value)) patch({[key]:Math.min(max, Math.max(min, +e.target.value))}); }}/></label>;
  const toggle = (key: string, label: string, disabled = false) =>
    <label className="nai-stream" key={key}><input type="checkbox" checked={params[key] === true} disabled={disabled}
      onChange={e => patch({[key]:e.target.checked})}/>{label}</label>;
  return <>
    {numeric('cfg_rescale', 'Guidance Rescale', 0, 0, 1, .01)}
    {numeric('uncond_scale', '负面提示词强度', 1, 0, 2, .05)}
    {!v5 && <>
      <label>噪声调度<select aria-label="噪声调度" value={String(params.noise_schedule ?? defaultNoiseSchedule(params.sampler))} onChange={e => patch({noise_schedule:e.target.value})}>
        {noiseSchedulesFor(model,params.sampler).map(value => <option key={value}>{value}</option>)}
        {Boolean(params.noise_schedule) && !noiseSchedulesFor(model,params.sampler).includes(String(params.noise_schedule)) && <option>{String(params.noise_schedule)}（旧设置）</option>}
      </select></label>
      <label className="nai-stream"><input type="checkbox" checked={Number(params.skip_cfg_above_sigma) > 0}
        onChange={e => patch({skip_cfg_above_sigma:e.target.checked?varietySigma(model):null})}/>Variety+</label>
      {toggle('prefer_brownian','Brownian 噪声')}
    </>}
    {v3 && <>{toggle('sm','SMEA')}{toggle('sm_dyn','SMEA Dyn',params.sm !== true)}{toggle('dynamic_thresholding','Decrisp')}{toggle('legacy_v3_extend','旧版 V3 扩展')}</>}
    <small>切换模型后，不支持的选项保留在草稿中，不参与本次请求。</small>
    <button type="button" onClick={() => patch(modelGenerationDefaults(model))}>重置生成参数</button>
  </>;
}

