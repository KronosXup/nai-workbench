import type { Task } from './types';

export type QuoteRequest = {
  operation: 'generate-image' | 'upscale' | 'augment-image' | 'encode-vibe';
  model: string;
  parameters: Record<string, string | number | boolean>;
};

export function quoteRequest(task: Task): QuoteRequest {
  const p = task.parameters;
  if (task.operation === 'encode_vibe')
    return { operation: 'encode-vibe', model: task.model, parameters: {} };
  if (task.operation === 'upscale' || task.operation === 'augment') {
    return {
      operation: task.operation === 'upscale' ? 'upscale' : 'augment-image',
      model: task.model,
      parameters: {
        width: Number(p.source_width ?? p.width), height: Number(p.source_height ?? p.height),
        ...(task.operation === 'augment' ? { req_type: String(p.req_type ?? 'lineart') } : {}),
      },
    };
  }
  const vibes = p.reference_image_multiple ?? [];
  const extractedValues = p.reference_information_extracted_multiple ?? [];
  const pending = Array.isArray(p.vibe_pending_indices) ? p.vibe_pending_indices as number[] : [];
  const encodings = new Map<number, Set<string>>();
  for (const index of pending) {
    const extracted = extractedValues[index] ?? 1;
    const images = encodings.get(extracted) ?? new Set<string>();
    images.add(vibes[index]);
    encodings.set(extracted, images);
  }
  return {
    operation: 'generate-image', model: task.model,
    parameters: {
      mode: task.operation, width: p.width ?? 832, height: p.height ?? 1216, steps: p.steps ?? 28,
      n_samples: p.n_samples ?? 1,
      sm: task.operation !== 'img2img' && p.sm === true,
      sm_dyn: task.operation !== 'img2img' && p.sm_dyn === true,
      upscaled_enhance: p.upscaled_enhance === true,
      has_controlnet: Boolean(p.controlnet_model || p.controlnet_condition),
      vibe_count: vibes.length,
      precise_count: (p.character_reference_images ?? []).length,
      pending_vibe_encoding_count: [...encodings.values()].reduce((count, images) => count + images.size, 0),
      ...(task.operation === 'img2img' ? { strength: p.strength ?? 1 } : {}),
      ...(task.operation === 'inpaint' ? { inpaint_strength: p.img2img?.strength ?? 1 } : {}),
    },
  };
}

export type ImageQuote = {
  source: 'gate';
  effective_model?: string;
  requested_model?: string;
  units: number;
  unit_label: string;
  generation_units?: number;
  encoding_units?: number;
  verified: boolean;
  message: string;
  cost_limit: { anlas: number; v5: number };
  encoding_cost_limit: { anlas: number; v5: number };
  output_size?: [number, number] | null;
};

export function withQuote(task: Task, quote: ImageQuote | null): Task {
  if (quote?.source !== 'gate' || !quote.cost_limit || !quote.encoding_cost_limit)
    throw new Error('请先取得 Gate 报价，再提交任务');
  return { ...task, cost_limit: { ...quote.cost_limit },
    parameters: { ...task.parameters, vibe_encoding_cost_limit: { ...quote.encoding_cost_limit } } };
}
