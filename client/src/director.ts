import { defaultParameters, uuid } from './types';
import type { Draft, Job, Task } from './types';

export const directorTools = [
  ['bg-removal', '去除背景'], ['lineart', '线稿'], ['sketch', '草图'],
  ['colorize', '上色'], ['emotion', '表情'], ['declutter', '清理杂物'],
  ['declutter-keep-bubbles', '清理杂物（保留气泡）'],
] as const;
export type DirectorTool = typeof directorTools[number][0];
export const directorEmotions = [
  ['neutral', '自然'], ['happy', '开心'], ['sad', '难过'], ['angry', '生气'],
  ['surprised', '惊讶'], ['scared', '害怕'], ['excited', '兴奋'], ['shy', '害羞'],
  ['tired', '疲倦'], ['nervous', '紧张'], ['thinking', '思考'], ['confused', '困惑'],
  ['disgusted', '厌恶'], ['smug', '得意'], ['bored', '无聊'], ['laughing', '大笑'],
  ['irritated', '烦躁'], ['aroused', '动情'], ['embarrassed', '尴尬'], ['worried', '担忧'],
  ['love', '爱意'], ['determined', '坚定'], ['hurt', '受伤'], ['playful', '俏皮'],
] as const;
export type DirectorSource = { data: string; width: number; height: number; name: string };
export type DirectorDraft = {
  model: string;
  tool: DirectorTool;
  prompt: string;
  emotion: string;
  defry: number;
  source?: DirectorSource;
  resultId?: string;
};

export function directorSourceIssue(source?: DirectorSource): string | undefined {
  if (!source) return '请先选择要处理的图片。';
  if (typeof source.data !== 'string' || source.data.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/=\s]+$/.test(source.data))
    return '图片数据无效，请重新选择图片。';
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1 || source.width * source.height > 3_145_728)
    return '导演工具支持最多 314 万像素，请先缩小图片。';
}

// Separate tool data shares the existing per-user draft transaction and backup,
// but never replaces drawing prompts, references, dimensions or operation.
export function readDirectorDraft(value: unknown, model = 'nai-diffusion-4-5-full'): DirectorDraft {
  const raw = value && typeof value === 'object' ? value as Partial<DirectorDraft> : {};
  const source = raw.source && typeof raw.source === 'object' ? raw.source : undefined;
  return {
    model: typeof raw.model === 'string' ? raw.model : model,
    tool: directorTools.some(([id]) => id === raw.tool) ? raw.tool! : 'lineart',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    emotion: directorEmotions.some(([id]) => id === raw.emotion) ? raw.emotion! : 'neutral',
    defry: Number.isInteger(raw.defry) ? Math.max(0, Math.min(5, raw.defry!)) : 0,
    source: source ? {
      data: typeof source.data === 'string' ? source.data : '',
      width: typeof source.width === 'number' ? source.width : 0,
      height: typeof source.height === 'number' ? source.height : 0,
      name: typeof source.name === 'string' ? source.name : '原图',
    } : undefined,
    resultId: typeof raw.resultId === 'string' ? raw.resultId : undefined,
  };
}

export function directorFromJob(job: Pick<Job, 'model' | 'prompt' | 'parameters'>, resultId?: string): DirectorDraft {
  const p = job.parameters;
  return readDirectorDraft({
    model: job.model, tool: p.req_type, prompt: job.prompt, defry: p.defry, emotion: p.emotion,
    source: typeof p.image === 'string' ? { data: p.image, width: Number(p.source_width ?? p.width), height: Number(p.source_height ?? p.height), name: '原图' } : undefined,
    resultId,
  });
}

export function migrateDirectorDraft(draft: Draft): Draft {
  if (draft.operation !== 'augment') return { ...draft, director: readDirectorDraft(draft.director, draft.model) };
  // Older versions overwrote the drawing draft. Retain those fields and source;
  // a previously overwritten drawing cannot be reconstructed from this record.
  return { ...draft, director: directorFromJob(draft), operation: draft.parameters.image ? 'img2img' : 'generate' };
}

export function directorTask(state: DirectorDraft): Task {
  const source = state.source;
  return {
    request_id: uuid(), operation: 'augment', model: state.model,
    prompt: ['colorize', 'emotion'].includes(state.tool) ? state.prompt : '', negative_prompt: '',
    label: `导演 · ${directorTools.find(([id]) => id === state.tool)?.[1] ?? '图片处理'}`,
    parameters: {
      ...structuredClone(defaultParameters), width: source?.width ?? 0, height: source?.height ?? 0,
      source_width: source?.width, source_height: source?.height, image: source?.data,
      req_type: state.tool,
      ...(['colorize', 'emotion'].includes(state.tool) ? { defry: state.defry } : {}),
      ...(state.tool === 'emotion' ? { emotion: state.emotion } : {}),
    },
  };
}

export function directorMatchesJob(state: DirectorDraft, job: Job) {
  if (job.operation !== 'augment' || state.model !== job.model || !state.source || state.source.data !== job.parameters.image || state.tool !== job.parameters.req_type) return false;
  if (['colorize', 'emotion'].includes(state.tool) && (state.prompt !== job.prompt || state.defry !== Number(job.parameters.defry ?? 0))) return false;
  return state.tool !== 'emotion' || state.emotion === (job.parameters.emotion ?? 'neutral');
}
