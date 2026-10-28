import type { ImportedImage } from './imageImport';
import type { Task } from './types';
import type { EnhanceSettings } from './EnhancePanel';

export function enhanceScales(width: number, height: number, model: string) {
  const portrait = (width === 832 && height === 1216) || (width === 1216 && height === 832);
  const scales: { value: number | 'max'; label: string; disabled?: boolean; title?: string }[] =
    (portrait ? [1, 1.5] : [1, 1.5, 2].filter(scale =>
      width * height * scale * scale <= 3145728 && !(width * scale % 64) && !(height * scale % 64)))
      .map(value => ({ value, label: `${value}×` }));
  if (['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-5-full-medium'].includes(model)
    && Math.min(width, height) >= 64 && Math.max(width, height) <= 4096 && width * height < 2516582.4)
    scales.push({ value: 'max', label: 'Max' });
  return scales;
}

export function enhanceDimensions(width: number, height: number, scale: number | 'max') {
  if (scale === 'max') {
    width = Math.round(width / 64) * 64;
    height = Math.round(height / 64) * 64;
    const factor = Math.min(2, Math.sqrt(3145728 / (width * height)));
    return { width: Math.floor(width * factor), height: Math.floor(height * factor) };
  }
  const factor = typeof scale === 'number' ? scale : 1;
  return { width: Math.round(Math.floor(width * factor) / 64) * 64,
    height: Math.round(Math.floor(height * factor) / 64) * 64 };
}

export function enhanceTask(base: Task, image: Pick<ImportedImage, 'data' | 'width' | 'height'>, settings: EnhanceSettings): Task {
  const allowed = enhanceScales(image.width, image.height, base.model)
    .some(option => option.value === settings.scale && !option.disabled);
  if (!allowed) throw new Error('当前图片不支持所选增强尺寸');
  const size = settings.scale === 'max' ? enhanceDimensions(image.width, image.height, 1) : enhanceDimensions(image.width, image.height, settings.scale);
  const parameters: Task['parameters'] = { ...structuredClone(base.parameters), ...size,
    image: image.data, source_width: image.width, source_height: image.height,
    strength: settings.strength, noise: settings.noise, n_samples: 1, seed: -1, enhance: true };
  for (const key of ['mask', 'img2img', 'upscale', 'upscaled_enhance', 'canvas_project_id']) delete parameters[key];
  if (settings.scale === 'max') parameters.upscaled_enhance = true;
  if (base.model.startsWith('nai-diffusion-5')) parameters.straight_alpha = true;
  else delete parameters.straight_alpha;
  let prompt = base.prompt;
  if (settings.scale !== 'max' && /nai-diffusion-(4-5|5)-/.test(base.model) && !prompt.includes('upscaled, blurry')) {
    const index = prompt.search(/(?:^|\s|[,.:[\]{}、。])text:(?!:)/i);
    const at = index < 0 ? prompt.length : index;
    prompt = prompt.slice(0, at) + ', -2::upscaled, blurry::,' + prompt.slice(at);
  }
  return { ...base, prompt, operation: 'img2img', parameters, label: 'Enhance' };
}
