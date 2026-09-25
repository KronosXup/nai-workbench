import { sha256 } from "@noble/hashes/sha256";

export const MAX_CANVAS_PIXELS = 4_194_304;
export const MAX_CANVAS_SIDE = 4096;
export const MAX_CANVAS_LAYERS = 6;
export const MAX_CANVAS_SOURCE_BYTES = 24 * 1024 * 1024;
export const MAX_CANVAS_LAYER_BYTES = 20 * 1024 * 1024;
export const MAX_CANVAS_PROJECT_BYTES = 96 * 1024 * 1024;

export type CanvasProjectLayer = {
  id: number;
  name: string;
  visible: boolean;
  blob: Blob;
};

export type CanvasProject = {
  version: 1;
  width: number;
  height: number;
  base: Blob;
  layers: CanvasProjectLayer[];
};

type BackupCandidate = {
  outputHash: string;
  saved_at: number;
  base: Blob;
  layers: { blob: Blob }[];
};

// Keep active/referenced work first, then the most recent unreferenced projects.
// Omitted projects stay untouched in IndexedDB and are reported in the backup UI.
export function selectCanvasProjectsForBackup<T extends BackupCandidate>(
  projects: T[], priority: Map<string, number>, maxCount = 128, maxBytes = 512 * 1024 * 1024,
) {
  const ranked = [...projects].sort((a, b) =>
    (priority.get(b.outputHash) ?? 0) - (priority.get(a.outputHash) ?? 0) || b.saved_at - a.saved_at);
  const selected: T[] = [];
  let usedBytes = 0;
  let referencedOmitted = 0;
  for (const project of ranked) {
    const bytes = project.base.size + project.layers.reduce((sum, layer) => sum + layer.blob.size, 0);
    if (selected.length < maxCount && usedBytes + bytes <= maxBytes) {
      selected.push(project);
      usedBytes += bytes;
    } else if ((priority.get(project.outputHash) ?? 0) > 0) referencedOmitted++;
  }
  return { selected, omitted: projects.length - selected.length, referencedOmitted };
}

// Only a digest of the access key enters the local database key; the key itself never does.
export function canvasProjectScope(owner: string, accessKey: string) {
  if (!owner || !accessKey.trim()) throw new Error("当前连接尚未就绪。");
  const digest = Array.from(sha256(new TextEncoder().encode(accessKey.trim())), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${owner}|key-sha256:${digest}`;
}

export function validateCanvasProject(input: unknown): asserts input is CanvasProject {
  if (!input || typeof input !== "object") throw new Error("画布工程格式无效。");
  const project = input as Partial<CanvasProject>;
  if (project.version !== 1 || !Number.isInteger(project.width) || !Number.isInteger(project.height) ||
    !project.width || !project.height || project.width > MAX_CANVAS_SIDE || project.height > MAX_CANVAS_SIDE ||
    project.width * project.height > MAX_CANVAS_PIXELS) throw new Error("画布工程尺寸无效。");
  if (!(project.base instanceof Blob) || !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(project.base.type) ||
    project.base.size < 1 || project.base.size > MAX_CANVAS_SOURCE_BYTES) throw new Error("画布工程底图无效或过大。");
  if (!Array.isArray(project.layers) || project.layers.length < 1 || project.layers.length > MAX_CANVAS_LAYERS) throw new Error("画布工程图层数量无效。");
  const ids = new Set<number>();
  let total = project.base.size;
  for (const layer of project.layers) {
    if (!layer || !Number.isSafeInteger(layer.id) || layer.id < 1 || ids.has(layer.id) ||
      typeof layer.name !== "string" || layer.name.length < 1 || layer.name.length > 80 ||
      typeof layer.visible !== "boolean" || !(layer.blob instanceof Blob) ||
      layer.blob.type !== "image/png" || layer.blob.size < 1 || layer.blob.size > MAX_CANVAS_LAYER_BYTES)
      throw new Error("画布工程含无效图层。");
    ids.add(layer.id);
    total += layer.blob.size;
  }
  if (total > MAX_CANVAS_PROJECT_BYTES) throw new Error("画布工程超过 96 MB，请减少图层或缩小画布。");
}
