// Tag data follows the current official client; the public qualitytags page
// differs for V4.5 and V4 Curated, so these variants use the live client values.
// Presets are composed at request time; switching them never edits the user's text.
import { joinPrompt } from './types';
import type { Draft, Strings } from './types';

const quality: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': '{best quality}, {amazing quality}',
};
const heavy = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const furry = '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic';
const curatedHeavy = 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page';
export function ucOptions(model: string): Record<string, string> {
  if (model.startsWith('nai-diffusion-5') || model === 'nai-diffusion-4-5-full') return {
    none: '', heavy, light: model.startsWith('nai-diffusion-5')
      ? 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::'
      : 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
    furry, human: `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`,
  };
  if (model === 'nai-diffusion-4-5-curated') return {none:'', heavy:curatedHeavy,
    light:'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
    human:'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page'};
  if (model.startsWith('nai-diffusion-4')) {
    const base = 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing';
    return {none:'', light:base + (model.includes('curated') ? ', logo, dated, signature' : '') + ', white blank page, blank page',
      heavy:'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration' + (model.includes('curated') ? ', logo, dated, signature, multiple views, gigantic breasts' : ', multiple views, logo, too many watermarks') + ', white blank page, blank page'};
  }
  if (model.includes('furry')) return {none:'lowres',
    light:'{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text',
    heavy:'{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast'};
  const v3 = 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]';
  return {none:'lowres', heavy:v3, light:'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing', human:`${v3}, bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes`};
}
export const presetLabels: Record<string,string> = {none:'无',standard:'标准',light:'轻量',heavy:'强力',furry:'Furry 优先',human:'人物优先'};
// Match the official client's category fallback when a model lacks a UC preset.
export function mapUcPreset(sourceModel: string, presetId: string | undefined, targetModel: string) {
  const source = ucOptions(sourceModel);
  const category = presetId && source[presetId] !== undefined ? presetId : 'none';
  const fallbacks: Record<string,string[]> = {
    none:['none','light','heavy'], light:['light','none','heavy'],
    heavy:['heavy','light','none'], human:['human','heavy','light','none'],
    furry:['furry','heavy','light','none'],
  };
  const target = ucOptions(targetModel);
  return (fallbacks[category] ?? fallbacks.none).find(id => target[id] !== undefined) ?? 'none';
}
export function hasFurryTag(prompt: string) {
  return /^\s*(?:fur|background) dataset\s*(?:,|$)/i.test(prompt);
}
export function removeFurryTag(prompt: string) {
  // Switching to Anime removes only the leading mode marker, not a tag inside a prompt.
  return prompt.replace(/^\s*(?:fur|background) dataset\s*(?:,\s*)?/i, '');
}
export function composePrompts(draft: Draft, prompt: string, strings: Strings) {
  const q = draft.qualityPreset === 'light' && draft.model.startsWith('nai-diffusion-5')
    ? 'very aesthetic, amazing quality, no text' : draft.qualityPreset && draft.qualityPreset !== 'none' ? quality[draft.model] : '';
  const negative = ucOptions(draft.model)[draft.ucPreset ?? 'none'] ?? '';
  const positive=joinPrompt(strings.artist, prompt, strings.quality, q ?? '');
  // V3's default lowres fallback applies only when the user did not supply UC.
  const defaultNegative = (draft.model === 'nai-diffusion-3' || draft.model === 'nai-diffusion-furry-3')
    && (draft.ucPreset ?? 'none') === 'none' && strings.negative.trim() ? '' : negative;
  return {
    prompt:draft.furryMode && !draft.model.endsWith('-3') && !hasFurryTag(positive) ? `fur dataset, ${positive}` : positive,
    negative:joinPrompt(
      !draft.model.includes('curated') && draft.ucPreset && draft.ucPreset !== 'none' && negative && !positive.toLowerCase().includes('nsfw') ? 'nsfw' : '',
      defaultNegative, strings.negative),
  };
}
