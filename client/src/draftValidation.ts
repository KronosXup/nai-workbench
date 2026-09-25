import { newDraft, defaultParameters } from "./types";
import type { Draft, Operation } from "./types";
import { directorEmotions, directorTools, readDirectorDraft } from "./director";
import { readVibeFile } from "./vibeFiles";

export class InvalidDraftError extends Error {
  readonly path?: string;

  constructor(path?: string) {
    super("绘图草稿不完整或已损坏。");
    this.name = "InvalidDraftError";
    this.path = path;
  }
}

type RecordValue = Record<string, unknown>;
const operations: Operation[] = ["generate", "img2img", "inpaint", "upscale", "augment", "encode_vibe"];
const own = (value: RecordValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown) => Number.isSafeInteger(value);
const text = (value: unknown) => typeof value === "string";

function fail(path: string): never {
  throw new InvalidDraftError(path);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) fail(path);
  return value;
}

function requireString(value: unknown, path: string, nonempty = false) {
  if (!text(value) || (nonempty && value.length === 0)) fail(path);
}

function requireFinite(value: unknown, path: string) {
  if (!finite(value)) fail(path);
}

function requireInteger(value: unknown, path: string) {
  if (!integer(value)) fail(path);
}

function validateStringArray(value: unknown, path: string) {
  if (!Array.isArray(value) || value.some(item => !text(item))) fail(path);
}

function validateNumberArray(value: unknown, path: string) {
  if (!Array.isArray(value) || value.some(item => !finite(item))) fail(path);
}

async function validateVibeItemAsync(value: unknown, path: string) {
  if (value === null) return;
  if (typeof File === "undefined") fail(path);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail(path);
    const items = await readVibeFile(new File([serialized], "draft.naiv4vibe", { type: "application/json" }));
    if (items.length !== 1) fail(path);
  } catch {
    fail(path);
  }
}

export async function validateParameters(value: unknown, path: string): Promise<RecordValue> {
  const parameters = requireRecord(value, path);
  for (const key of ["width", "height", "steps", "seed", "n_samples"]) {
    if (!own(parameters, key)) fail(`${path}.${key}`);
    requireInteger(parameters[key], `${path}.${key}`);
  }
  for (const key of ["scale", "strength", "noise"]) {
    if (!own(parameters, key)) fail(`${path}.${key}`);
    requireFinite(parameters[key], `${path}.${key}`);
  }
  if (!own(parameters, "sampler")) fail(`${path}.sampler`);
  requireString(parameters.sampler, `${path}.sampler`, true);

  for (const key of [
    "character_prompts", "reference_image_multiple", "reference_strength_multiple",
    "reference_information_extracted_multiple", "character_reference_images",
  ]) {
    if (!own(parameters, key)) fail(`${path}.${key}`);
  }
  if (!Array.isArray(parameters.character_prompts)) fail(`${path}.character_prompts`);
  for (const [index, raw] of parameters.character_prompts.entries()) {
    const character = requireRecord(raw, `${path}.character_prompts[${index}]`);
    requireString(character.prompt, `${path}.character_prompts[${index}].prompt`);
    requireString(character.negative_prompt, `${path}.character_prompts[${index}].negative_prompt`);
    requireFinite(character.x, `${path}.character_prompts[${index}].x`);
    requireFinite(character.y, `${path}.character_prompts[${index}].y`);
    if (character.enabled !== undefined && typeof character.enabled !== "boolean")
      fail(`${path}.character_prompts[${index}].enabled`);
  }
  validateStringArray(parameters.reference_image_multiple, `${path}.reference_image_multiple`);
  validateNumberArray(parameters.reference_strength_multiple, `${path}.reference_strength_multiple`);
  validateNumberArray(parameters.reference_information_extracted_multiple, `${path}.reference_information_extracted_multiple`);
  validateStringArray(parameters.character_reference_images, `${path}.character_reference_images`);

  for (const key of ["character_reference_descriptions"]) {
    if (parameters[key] !== undefined) validateStringArray(parameters[key], `${path}.${key}`);
  }
  for (const key of ["character_reference_strengths", "character_reference_fidelities"]) {
    if (parameters[key] !== undefined) validateNumberArray(parameters[key], `${path}.${key}`);
  }
  for (const key of ["image", "mask", "req_type", "emotion"]) {
    if (parameters[key] !== undefined) requireString(parameters[key], `${path}.${key}`);
  }
  if (parameters.vibe_source_images !== undefined && typeof parameters.vibe_source_images !== "string")
    validateStringArray(parameters.vibe_source_images, `${path}.vibe_source_images`);
  for (const key of ["scale_factor", "source_width", "source_height"]) {
    if (parameters[key] !== undefined) requireFinite(parameters[key], `${path}.${key}`);
  }
  if (parameters.defry !== undefined) {
    requireInteger(parameters.defry, `${path}.defry`);
    if ((parameters.defry as number) < 0 || (parameters.defry as number) > 5) fail(`${path}.defry`);
  }
  if (parameters.vibe_encodings !== undefined) {
    const encodings = requireRecord(parameters.vibe_encodings, `${path}.vibe_encodings`);
    for (const [key, encoding] of Object.entries(encodings))
      requireString(encoding, `${path}.vibe_encodings.${key}`);
  }
  if (parameters.vibe_files !== undefined) {
    if (!Array.isArray(parameters.vibe_files)) fail(`${path}.vibe_files`);
    for (const [index, item] of parameters.vibe_files.entries())
      await validateVibeItemAsync(item, `${path}.vibe_files[${index}]`);
  }
  if (parameters.vibe_source_files !== undefined) {
    if (!Array.isArray(parameters.vibe_source_files)) fail(`${path}.vibe_source_files`);
    for (const [index, item] of parameters.vibe_source_files.entries())
      await validateVibeItemAsync(item, `${path}.vibe_source_files[${index}]`);
  }
  return parameters;
}

function validateBatch(value: unknown, fallback: Draft["batch"]): Draft["batch"] {
  const batch = requireRecord(value, "批量草稿");
  const shared = requireRecord(batch.shared, "批量共用文案");
  const unified = requireRecord(batch.unified, "批量统一选项");
  for (const key of ["artist", "quality", "negative"] as const) {
    requireString(shared[key], `批量共用文案.${key}`);
    if (typeof unified[key] !== "boolean") fail(`批量统一选项.${key}`);
  }
  if (!Array.isArray(batch.items) || batch.items.length !== 5) fail("批量项目");
  const items = batch.items.map((raw, index) => {
    const item = requireRecord(raw, `批量项目[${index}]`);
    for (const key of ["id", "prompt", "artist", "quality", "negative"])
      requireString(item[key], `批量项目[${index}].${key}`, key === "id");
    requireInteger(item.count, `批量项目[${index}].count`);
    if ((item.count as number) < 0) fail(`批量项目[${index}].count`);
    if (typeof item.enabled !== "boolean") fail(`批量项目[${index}].enabled`);
    return { ...item };
  });
  return {
    ...fallback,
    ...batch,
    shared: { ...fallback.shared, ...shared },
    unified: { ...fallback.unified, ...unified },
    items,
  } as Draft["batch"];
}

function validatePresets(value: unknown): Draft["presets"] {
  if (!Array.isArray(value)) fail("预设列表");
  return value.map((raw, index) => {
    const preset = requireRecord(raw, `预设[${index}]`);
    for (const key of ["id", "name", "prompt", "artist", "quality", "negative"])
      requireString(preset[key], `预设[${index}].${key}`, ["id", "name"].includes(key));
    if (preset.qualityPreset !== undefined && !["none", "standard", "light"].includes(String(preset.qualityPreset)))
      fail(`预设[${index}].qualityPreset`);
    if (preset.ucPreset !== undefined) requireString(preset.ucPreset, `预设[${index}].ucPreset`);
    if (preset.furryMode !== undefined && typeof preset.furryMode !== "boolean") fail(`预设[${index}].furryMode`);
    return { ...preset };
  }) as Draft["presets"];
}

function validateDirector(value: unknown, model: string) {
  if (value === undefined) return undefined;
  const director = requireRecord(value, "导演草稿");
  if (director.model !== undefined) requireString(director.model, "导演草稿.model", true);
  if (director.tool !== undefined && !directorTools.some(([id]) => id === director.tool)) fail("导演草稿.tool");
  if (director.prompt !== undefined) requireString(director.prompt, "导演草稿.prompt");
  if (director.emotion !== undefined && !directorEmotions.some(([id]) => id === director.emotion)) fail("导演草稿.emotion");
  if (director.defry !== undefined && (!integer(director.defry) || (director.defry as number) < 0 || (director.defry as number) > 5))
    fail("导演草稿.defry");
  if (director.resultId !== undefined) requireString(director.resultId, "导演草稿.resultId");
  if (director.source !== undefined) {
    const source = requireRecord(director.source, "导演原图");
    requireString(source.data, "导演原图.data", true);
    if ((source.data as string).length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/=\s]+$/.test(source.data as string)) fail("导演原图.data");
    requireInteger(source.width, "导演原图.width");
    requireInteger(source.height, "导演原图.height");
    if (source.name !== undefined) requireString(source.name, "导演原图.name");
    if ((source.width as number) < 1 || (source.height as number) < 1 || (source.width as number) * (source.height as number) > 3_145_728)
      fail("导演原图尺寸");
  }
  const normalized = readDirectorDraft(director, model);
  return {
    ...director,
    ...normalized,
    ...(isRecord(director.source) && normalized.source
      ? { source: { ...director.source, ...normalized.source } }
      : {}),
  };
}

export async function validateDraft(value: unknown): Promise<Draft> {
  const raw = requireRecord(value, "草稿");
  const defaults = newDraft();
  requireString(raw.model, "草稿.model", true);
  if (!operations.includes(raw.operation as Operation)) fail("草稿.operation");
  requireString(raw.prompt, "草稿.prompt");
  requireString(raw.artist, "草稿.artist");
  requireString(raw.quality, "草稿.quality");
  requireString(raw.negative, "草稿.negative");
  requireInteger(raw.count, "草稿.count");
  if ((raw.count as number) < 0) fail("草稿.count");

  const parameters = await validateParameters(raw.parameters, "生成参数");
  const batch = validateBatch(raw.batch, defaults.batch);
  const presets = validatePresets(raw.presets);
  const result = {
    ...defaults,
    ...raw,
    parameters: { ...structuredClone(defaultParameters), ...parameters },
    batch,
    presets,
  } as Draft;
  for (const key of ["character_reference_descriptions", "character_reference_strengths", "character_reference_fidelities"] as const) {
    if (parameters[key] === undefined)
      (result.parameters as Record<string, unknown>)[key] = structuredClone(defaultParameters[key]);
  }
  if (raw.qualityPreset === undefined) result.qualityPreset = defaults.qualityPreset;
  if (raw.ucPreset === undefined) result.ucPreset = defaults.ucPreset;

  if (raw.qualityPreset !== undefined && !["none", "standard", "light"].includes(String(raw.qualityPreset)))
    fail("草稿.qualityPreset");
  if (raw.ucPreset !== undefined) requireString(raw.ucPreset, "草稿.ucPreset");
  for (const key of ["tagSuggestionsDisabled", "furryMode"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(`草稿.${key}`);
  }
  if (raw.randomPrompt !== undefined) requireString(raw.randomPrompt, "草稿.randomPrompt");
  if (raw.promptLayout !== undefined && !["split", "tabs"].includes(String(raw.promptLayout))) fail("草稿.promptLayout");
  if (raw.chunks !== undefined) {
    if (!Array.isArray(raw.chunks)) fail("提示词片段");
    result.chunks = raw.chunks.map((value, index) => {
      const chunk = requireRecord(value, `提示词片段[${index}]`);
      for (const key of ["id", "name", "text", "category"])
        requireString(chunk[key], `提示词片段[${index}].${key}`, key === "id");
      return { ...chunk } as { id: string; name: string; text: string; category: string };
    });
  }
  const director = validateDirector(raw.director, raw.model as string);
  if (director !== undefined) result.director = director;
  return result;
}
