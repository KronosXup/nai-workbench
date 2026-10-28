import type { ImportedImage } from './imageImport';
import type { Task } from './types';
import type { EnhanceSettings } from './EnhancePanel';

export function enhanceScales(width: number, height: number, model: string) {
  const portrait = (width === 832 && height === 1216) || (width === 1216 && height === 832);
  const scales: { value: number | 'max'; label: string; disabled?: boolean; title?: string }[] =
    (portrait ? [1, 1.5] : [1, 1.5, 2].filter(scale =>
      width * height * scale * scale <= 3145728 && !(width * scale % 64) && !(height * scale % 64)))
      .map(value => ({ value, label: `${value}×` }));
  if (model.startsWith('nai-diffusion-5') && width * height > 0 && width * height < 2516582.4)
    scales.push({ value: 'max', label: 'Max', disabled: true, title: '当前服务尚未核实 Max 增强及其费用' });
  return scales;
}

export function enhanceDimensions(width: number, height: number, scale: number | 'max') {
  const factor = typeof scale === 'number' ? scale : 1;
  return { width: Math.round(Math.floor(width * factor) / 64) * 64,
    height: Math.round(Math.floor(height * factor) / 64) * 64 };
}

export function enhanceTask(base: Task, image: Pick<ImportedImage, 'data' | 'width' | 'height'>, settings: EnhanceSettings): Task {
  const allowed = enhanceScales(image.width, image.height, base.model)
    .some(option => option.value === settings.scale && !option.disabled);
  if (!allowed) throw new Error('当前图片不支持所选增强尺寸');
  const parameters: Task['parameters'] = { ...structuredClone(base.parameters), ...enhanceDimensions(image.width, image.height, settings.scale),
    image: image.data, source_width: image.width, source_height: image.height,
    strength: settings.strength, noise: settings.noise, n_samples: 1, seed: -1 };
  for (const key of ['mask', 'img2img', 'upscale', 'upscaled_enhance', 'canvas_project_id']) delete parameters[key];
  return { ...base, operation: 'img2img', parameters, label: 'Enhance' };
}
