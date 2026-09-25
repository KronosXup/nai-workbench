export type Operation =
  | "generate"
  | "img2img"
  | "inpaint"
  | "upscale"
  | "augment"
  | "encode_vibe";
export type CharacterPrompt = {
  enabled?: boolean;
  prompt: string;
  negative_prompt: string;
  x: number;
  y: number;
};
export type Parameters = {
  width: number;
  height: number;
  steps: number;
  scale: number;
  seed: number;
  sampler: string;
  n_samples: number;
  strength: number;
  noise: number;
  character_prompts: CharacterPrompt[];
  image?: string;
  mask?: string;
  reference_image_multiple: string[];
  reference_strength_multiple: number[];
  reference_information_extracted_multiple: number[];
  character_reference_images: string[];
  character_reference_descriptions?: string[];
  character_reference_strengths?: number[];
  character_reference_fidelities?: number[];
  req_type?: string;
  scale_factor?: number;
  vibe_encodings?: Record<string, string>;
  vibe_files?: (import('./vibeFiles').VibeFileItem | null)[];
  [key: string]: unknown;
};
export type Task = {
  request_id: string;
  operation: Operation;
  model: string;
  prompt: string;
  negative_prompt: string;
  parameters: Parameters;
  label: string;
};
export type Result = {
  id: string;
  job_id: string;
  media_type: string;
  filename: string;
  sha256: string;
  size: number;
  expires_at: number;
  deleted: boolean;
  acknowledged: boolean;
  metadata: Record<string, unknown>;
};
export type QueueWaitReason = "rpm" | "cooldown" | "key_busy" | "service_busy";
export type Job = Task & {
  id: string;
  status:
    | "queued"
    | "waiting"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "cancelled";
  created_at: number;
  started_at?: number;
  completed_at?: number;
  retry_at?: number;
  retry_count?: number;
  retry_reason?: QueueWaitReason;
  execution_phase?: "submitting" | "waiting_result" | "generating";
  last_data_at?: number;
  error?: string;
  results: Result[];
  quota_units: number;
  storage_mode: string;
  retention_hours: number;
};
export type User = {
  gate_quota?: { anlasLeft: number; anlasEnabled?: boolean; anlasMonthlyLimit?: number; isAdmin?: boolean; v5LeftToday: number; v5Unlimited: boolean; imageModelScope: string };
  id: string;
  name: string;
  is_admin: boolean;
  quota: { limit: number; used: number; reserved: number; remaining: number };
  storage_policy: { mode: string; retention_hours: number };
};
export type Capabilities = {
  backend?: "gate";
  models: {
    id: string;
    name: string;
    max_characters?: number;
    precise_reference?: boolean;
    vibe_transfer?: boolean;
  }[];
  operations: Operation[];
  mode: "mock" | "nai";
  live_verified: boolean;
};
export type StorageSettings = {
  mode: "retain_until_expiry" | "delete_after_ack";
  retention_hours: number;
  max_pending_per_user: number;
  max_storage_mb: number;
};
export type LocalImage = {
  key: string;
  owner: string;
  id: string;
  job: Job;
  result: Result;
  blob: Blob;
  stored_at: number;
  imported?: boolean;
};
export type Strings = { artist: string; quality: string; negative: string };
export type BatchItem = Strings & {
  id: string;
  prompt: string;
  count: number;
  enabled: boolean;
};
export type BatchDraft = {
  shared: Strings;
  unified: Record<keyof Strings, boolean>;
  items: BatchItem[];
};
export type Draft = {
  director?: import('./director').DirectorDraft;
  chunks?: {id:string; name:string; text:string; category:string}[];
  /** Legacy draft text retained for backup compatibility; no longer used for generation. */
  randomPrompt?: string;
  tagSuggestionsDisabled?: boolean;
  furryMode?: boolean;
  qualityPreset?: "none" | "standard" | "light";
  ucPreset?: string;
  promptLayout?: "split" | "tabs";
  model: string;
  operation: Operation;
  prompt: string;
  artist: string;
  quality: string;
  negative: string;
  count: number;
  parameters: Parameters;
  batch: BatchDraft;
  presets: {
    qualityPreset?: "none" | "standard" | "light";
    ucPreset?: string;
    furryMode?: boolean;
    id: string;
    name: string;
    prompt: string;
    artist: string;
    quality: string;
    negative: string;
  }[];
};
export const defaultParameters: Parameters = {
  width: 832,
  height: 1216,
  steps: 23,
  scale: 5,
  seed: -1,
  sampler: "k_euler_ancestral",
  n_samples: 1,
  strength: 0.7,
  noise: 0,
  character_prompts: [],
  reference_image_multiple: [],
  reference_strength_multiple: [],
  reference_information_extracted_multiple: [],
  character_reference_images: [],
  character_reference_descriptions: [],
  character_reference_strengths: [],
  character_reference_fidelities: [],
};
export const uuid = () =>
  globalThis.crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      Number(c) ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
    ).toString(16),
  );
export const newDraft = (): Draft => ({
  model: "nai-diffusion-4-5-full",
  qualityPreset: "standard",
  ucPreset: "heavy",
  operation: "generate",
  prompt: "",
  artist: "",
  quality: "",
  negative: "",
  count: 1,
  parameters: structuredClone(defaultParameters),
  batch: {
    shared: { artist: "", quality: "", negative: "" },
    unified: { artist: true, quality: true, negative: true },
    items: Array.from({ length: 5 }, () => ({
      id: uuid(),
      prompt: "",
      artist: "",
      quality: "",
      negative: "",
      count: 1,
      enabled: true,
    })),
  },
  presets: [],
});
export const joinPrompt = (...parts: string[]) =>
  parts
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
export const labels: Record<Operation, string> = {
  generate: "文生图",
  img2img: "图生图",
  inpaint: "局部重绘",
  upscale: "高清放大",
  augment: "导演工具",
  encode_vibe: "提取 Vibe",
};
