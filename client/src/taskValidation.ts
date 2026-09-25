import type { Capabilities, Operation, Task } from './types';
import { samplersFor } from './modelSettings';
import { encodingFor } from './vibeFiles';
import type { VibeFileItem } from './vibeFiles';

export type ConfigurationIssue = {
  message: string;
  target: 'references' | 'characters' | 'settings';
  suggestedModel?: string;
};
export type QuoteError = { message: string; retryable: boolean; connection?: boolean };
export const usesGenerationSettings = (operation: Operation) =>
  ['generate', 'img2img', 'inpaint'].includes(operation);

export function effectiveModelForOperation(model: string, operation: Operation): string {
  return operation === 'inpaint' && model === 'nai-diffusion-5-curated'
    ? 'nai-diffusion-4-5-curated'
    : model;
}

// Quote, button state and submission share these rules. Prompt text is checked
// only at submission: an empty draft must still be able to show its cost.
export function configurationIssueFor(
  task: Pick<Task, 'model' | 'operation' | 'parameters'>,
  models: Capabilities['models'],
  operations?: Operation[],
): ConfigurationIssue | undefined {
  const { model, operation, parameters: p } = task;
  const effectiveModel = effectiveModelForOperation(model, operation);
  const info = models.find(item => item.id === effectiveModel);
  if (operations && !operations.includes(operation))
    return { message: '当前服务未提供这项操作，请更换生成方式。', target: 'references' };
  // Image tools do not send the saved character/reference settings. Keep those
  // settings for the next drawing task without blocking upscale or director tools.
  if (usesGenerationSettings(operation)) {
    if (!samplersFor(effectiveModel).some(([id]) => id === p.sampler))
      return { message: "请为当前模型选择可用采样器。", target: "settings" };
    if (p.character_reference_images.length && (!effectiveModel.startsWith('nai-diffusion-4-5') || info?.precise_reference === false))
      return {
        message: '精准参考仅支持 V4.5。参考图已保留，请切换模型或移除精准参考图。',
        target: 'references',
        suggestedModel: models.find(item => item.id.startsWith('nai-diffusion-4-5') && item.precise_reference !== false)?.id,
      };
    if (p.reference_image_multiple.length && (effectiveModel.startsWith('nai-diffusion-5') || info?.vibe_transfer === false))
      return { message: '当前模型不支持 Vibe。参考图已保留，请更换模型或移除 Vibe 参考图。', target: 'references' };
    const vibeFiles = p.vibe_files ?? p.vibe_source_files;
    if (vibeFiles !== undefined && !Array.isArray(vibeFiles))
      return { message: '保存的 Vibe 文件数据已损坏，请重新导入参考图。', target: 'references' };
    for (const [index, item] of ((vibeFiles ?? []) as (VibeFileItem | null)[]).entries()) {
      if (!item || index >= p.reference_image_multiple.length) continue;
      if (item.identifier !== 'novelai-vibe-transfer' || !['image','encoding'].includes(item.type))
        return { message: '保存的 Vibe 文件数据已损坏，请移除并重新导入该参考。', target: 'references' };
      const extracted = p.reference_information_extracted_multiple[index] ?? 1;
      if (item.type === 'encoding' && !encodingFor(item, effectiveModel, extracted))
        return { message: '这份 Vibe 编码不适用于当前模型。请切回导入时的模型或移除该参考。', target: 'references' };
      if (item.type === 'image' && item.importInfo?.mask && !encodingFor(item, effectiveModel, extracted, item.importInfo.mask))
        return { message: '带蒙版的 Vibe 原图没有当前模型与信息提取值对应的编码。请恢复原设置或移除该参考。', target: 'references' };
    }
    if (p.character_reference_images.length && p.reference_image_multiple.length)
      return { message: '精准参考与 Vibe 不能同时使用，请移除其中一类参考图。', target: 'references' };
    if (info?.max_characters !== undefined && p.character_prompts.filter(c => c.enabled !== false).length > info.max_characters)
      return { message: `当前模型最多支持 ${info.max_characters} 个角色，请更换模型或减少角色数量。`, target: 'characters' };
  }
  if (operation !== 'generate' && !p.image)
    return { message: '这个操作需要源图片，请先导入图片。', target: 'references' };
  if (operation === 'inpaint' && !p.mask)
    return { message: '请先绘制或上传重绘蒙版。', target: 'references' };
  if (usesGenerationSettings(operation) && (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 64 || p.height < 64 ||
      (usesGenerationSettings(operation) && (p.width % 8 || p.height % 8))))
    return { message: '宽高至少为 64；生成图片时还需为 8 的倍数。', target: 'settings' };
}
