import type { Parameters } from './types';

export const samplerOptions = [
  ['k_euler_ancestral', 'Euler Ancestral'], ['k_euler', 'Euler'],
  ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'], ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
  ['k_dpmpp_2m', 'DPM++ 2M'], ['k_dpmpp_sde', 'DPM++ SDE'], ['ddim_v3', 'DDIM'],
];
export const samplersFor = (model: string) => samplerOptions.filter(([id]) =>
  model.startsWith('nai-diffusion-5') ? id !== 'ddim_v3' : id !== 'k_dpmpp_2m_sde');

export function defaultNoiseSchedule(sampler: string) {
  if (sampler === 'k_dpmpp_2m' || sampler === 'k_dpm_2') return 'exponential';
  if (['k_euler','k_euler_ancestral','k_dpmpp_2s_ancestral','k_dpmpp_2m_sde','k_dpmpp_sde'].includes(sampler)) return 'karras';
  return 'native';
}
export function noiseSchedulesFor(model: string, sampler: string) {
  if (model.startsWith('nai-diffusion-5')) return [];
  const schedules = sampler === 'k_dpm_2' ? ['exponential','polyexponential'] :
    ['native','karras','exponential','polyexponential'];
  return model.endsWith('-3') ? schedules : schedules.filter(item => item !== 'native');
}
export function varietySigma(model: string) {
  if (model.startsWith('nai-diffusion-5')) return 0;
  return model.startsWith('nai-diffusion-4-5') ? 58 : 19;
}
export function varietyScale(width: number, height: number) {
  return Math.sqrt(Math.floor(width / 8) * Math.floor(height / 8) / (104 * 152));
}

// Imported values stay in the draft, but unsupported values must not travel into requests.
export function generationParameters(model: string, input: Parameters): Parameters {
  const p = structuredClone(input);
  if (!model.endsWith('-3')) { delete p.sm; delete p.sm_dyn; delete p.dynamic_thresholding; delete p.legacy_v3_extend; }
  if (model.startsWith('nai-diffusion-5')) { delete p.skip_cfg_above_sigma; delete p.prefer_brownian; }
  // V5 has no schedule selector, but the API still needs the sampler default.
  if (model.startsWith('nai-diffusion-5') || !noiseSchedulesFor(model,p.sampler).includes(String(p.noise_schedule)))
    p.noise_schedule = defaultNoiseSchedule(p.sampler);
  if (typeof p.skip_cfg_above_sigma === 'number' && p.skip_cfg_above_sigma > 0)
    p.skip_cfg_above_sigma *= varietyScale(p.width,p.height);
  if (model.endsWith("-3") && !p.sm) p.sm_dyn = false;
  return p;
}
export const advancedDefaults = {
  cfg_rescale: 0, sm: false, sm_dyn: false, dynamic_thresholding: false,
  use_coords: false, legacy_v3_extend: false, prefer_brownian: true,
  noise_schedule: 'karras', skip_cfg_above_sigma: null, uncond_scale: 1,
};
export function modelGenerationDefaults(model: string) {
  const scale = model.startsWith('nai-diffusion-5') ? 7 :
    model.startsWith('nai-diffusion-4-5') ? 5 :
    model.startsWith('nai-diffusion-4') ? 5.5 :
    model.includes('furry') ? 6.2 : 5;
  return {...advancedDefaults,steps:23,scale,seed:-1,sampler:'k_euler_ancestral'};
}
