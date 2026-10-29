import type { ImportedImage } from './imageImport';
import type { LocalImage, Task } from './types';
import { defaultParameters, uuid } from './types';
import { generationDimension, generationParameters } from './modelSettings';

export function variationTasks(row: LocalImage, image: ImportedImage, stream: boolean): Task[] {
  if (!['generate', 'img2img', 'inpaint'].includes(row.job.operation))
    throw new Error('请选择一张生成图片来制作变体');
  const original = row.job;
  // The saved job knows Full/Curated; official PNG Source may only say "V5".
  const model = original.model.replace(/-inpainting$/, '');
  const metadata = image.metadata;
  const parameters = generationParameters(model, {
    ...structuredClone(defaultParameters), ...structuredClone(original.parameters),
    ...metadata?.settings,
    character_prompts: structuredClone(metadata?.characters ?? original.parameters.character_prompts),
    width: generationDimension(image.width), height: generationDimension(image.height), image: image.data,
    strength: .8, noise: .1, n_samples: 1, stream,
  });
  // Use the finished image, never its old mask, crop or editable canvas project.
  for (const key of ['mask', 'img2img', 'upscale', 'enhance', 'upscaled_enhance', 'canvas_project_id', 'vibe_pending_indices']) delete parameters[key];
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  return Array.from({length: 3}, (_, index) => ({
    request_id: uuid(), operation: 'img2img', model,
    prompt: metadata?.prompt ?? original.prompt,
    negative_prompt: metadata?.negative ?? original.negative_prompt,
    parameters: {...structuredClone(parameters), seed: (seed + index) >>> 0},
    label: `变体 ${index + 1}/3`,
  }));
}
