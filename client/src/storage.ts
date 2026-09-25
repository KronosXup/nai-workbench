import { sha256 } from "@noble/hashes/sha256";
import type { Draft, Job, LocalImage, Result } from "./types";
import { selectCanvasProjectsForBackup, validateCanvasProject } from "./canvasProject";
import type { CanvasProject } from "./canvasProject";
import { InvalidDraftError, validateDraft, validateParameters } from "./draftValidation";
export { InvalidDraftError } from "./draftValidation";

const DATABASE = "nai-workbench-local-v1";
let connection: Promise<IDBDatabase> | undefined;
function db() {
  if (connection) return connection;
  let pending: Promise<IDBDatabase>;
  pending = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DATABASE, 3);
    let blocked = false;
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("images"))
        d.createObjectStore("images", { keyPath: "key" }).createIndex(
          "owner",
          "owner",
        );
      if (!d.objectStoreNames.contains("drafts"))
        d.createObjectStore("drafts", { keyPath: "owner" });
      if (!d.objectStoreNames.contains("removed"))
        d.createObjectStore("removed", { keyPath: "key" });
      if (!d.objectStoreNames.contains("canvasProjects"))
        d.createObjectStore("canvasProjects", { keyPath: "key" }).createIndex("scope", "scope");
    };
    r.onsuccess = () => {
      const opened = r.result;
      if (blocked) { opened.close(); return; }
      opened.onversionchange = () => { opened.close(); if (connection === pending) connection = undefined; };
      resolve(opened);
    };
    r.onerror = () => {
      if (connection === pending) connection = undefined;
      reject(r.error ?? new Error("本地数据库打开失败，请重试。"));
    };
    r.onblocked = () => {
      blocked = true;
      if (connection === pending) connection = undefined;
      reject(new Error("另一个工作台标签页仍使用旧版本地存储；请刷新该标签页后重试。"));
    };
  });
  connection = pending;
  return pending;
}
function complete(t: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("本地保存失败"));
    t.onabort = () => reject(t.error ?? new Error("本地保存被中止"));
  });
}
function value<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function digest(blob: Blob) {
  return Array.from(sha256(new Uint8Array(await blob.arrayBuffer())), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function gallery(owner: string) {
  const d = await db();
  return (
    (await value(
      d
        .transaction("images")
        .objectStore("images")
        .index("owner")
        .getAll(owner),
    )) as LocalImage[]
  ).sort((a, b) => b.stored_at - a.stored_at);
}
export async function getImage(owner: string, id: string) {
  const d = await db();
  return value(
    d.transaction("images").objectStore("images").get(`${owner}:${id}`),
  ) as Promise<LocalImage | undefined>;
}
export async function isRemoved(owner: string, id: string) {
  const d = await db();
  return Boolean(
    await value(
      d.transaction("removed").objectStore("removed").get(`${owner}:${id}`),
    ),
  );
}
export async function storeResult(
  owner: string,
  job: Job,
  result: Result,
  blob: Blob,
) {
  if ((await digest(blob)) !== result.sha256)
    throw new Error("图片校验未通过，未保存，也未确认删除服务器副本。");
  const record: LocalImage = {
    key: `${owner}:${result.id}`,
    owner,
    id: result.id,
    job: structuredClone(job),
    result: structuredClone(result),
    blob,
    stored_at: Date.now(),
  };
  const d = await db();
  const transaction = d.transaction(["images", "removed"], "readwrite");
  const committed = complete(transaction);
  let removed = false;
  const check = transaction.objectStore("removed").get(record.key);
  check.onsuccess = () => {
    removed = Boolean(check.result);
    if (!removed) transaction.objectStore("images").put(record);
  };
  await committed;
  return removed ? undefined : record;
}
export async function removeImage(owner: string, id: string) {
  const d = await db();
  const t = d.transaction(["images", "removed"], "readwrite");
  const done = complete(t);
  const key = `${owner}:${id}`;
  t.objectStore("images").delete(key);
  t.objectStore("removed").put({ key, owner, id, removed_at: Date.now() });
  await done;
}
export async function saveDraft(owner: string, draft: Draft) {
  const d = await db();
  const t = d.transaction("drafts", "readwrite");
  const done = complete(t);
  t.objectStore("drafts").put({ owner, draft });
  await done;
}
export async function readDraft(owner: string): Promise<Draft | undefined> {
  const d = await db();
  const record = await value(
    d.transaction("drafts").objectStore("drafts").get(owner),
  );
  if (record === undefined) return undefined;
  try {
    if (!record || record.owner !== owner) throw new InvalidDraftError("record.owner");
    return await validateDraft(record.draft);
  } catch (error) {
    if (error instanceof InvalidDraftError) throw error;
    throw new InvalidDraftError("draft");
  }
}
export async function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
export function fromBase64(data: string, type: string) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type });
}
type CanvasProjectRecord = CanvasProject & { key: string; scope: string; outputHash: string; saved_at: number };

function pngBytes(data: string) {
  const encoded = data.startsWith("data:image/png;base64,") ? data.slice("data:image/png;base64,".length) : data;
  if (!/^[a-z\d+/]+={0,2}$/i.test(encoded) || encoded.length > 28 * 1024 * 1024)
    throw new Error("合成 PNG 数据无效或过大。");
  const blob = fromBase64(encoded, "image/png");
  if (blob.size > 20 * 1024 * 1024) throw new Error("合成 PNG 超过 20 MB。");
  return blob;
}

async function projectHash(data: unknown) {
  if (typeof data !== "string") return undefined;
  try { return await digest(pngBytes(data)); }
  catch { return undefined; }
}

export async function readCanvasProject(scope: string, compositePng: string): Promise<CanvasProject | undefined> {
  if (!scope) throw new Error("当前连接尚未就绪。");
  const hash = await digest(pngBytes(compositePng));
  const d = await db();
  const row = await value(d.transaction("canvasProjects").objectStore("canvasProjects").get(`${scope}:${hash}`)) as CanvasProjectRecord | undefined;
  if (!row) return undefined;
  if (row.scope !== scope || row.outputHash !== hash) throw new Error("画布工程与当前源图不匹配。");
  validateCanvasProject(row);
  return { version: 1, width: row.width, height: row.height, base: row.base, layers: row.layers };
}

export async function saveCanvasProject(scope: string, compositePng: string, project: CanvasProject) {
  if (!scope) throw new Error("当前连接尚未就绪。");
  validateCanvasProject(project);
  const outputHash = await digest(pngBytes(compositePng));
  const record: CanvasProjectRecord = { ...project, scope, outputHash, key: `${scope}:${outputHash}`, saved_at: Date.now() };
  const d = await db();
  const t = d.transaction("canvasProjects", "readwrite");
  const done = complete(t);
  t.objectStore("canvasProjects").put(record);
  await done;
}

async function canvasProjects(scope: string): Promise<{ rows: CanvasProjectRecord[]; invalid: number; invalidHashes: string[] }> {
  if (!scope) return { rows: [], invalid: 0, invalidHashes: [] };
  const d = await db();
  const found = await value(d.transaction("canvasProjects").objectStore("canvasProjects").index("scope").getAll(scope)) as CanvasProjectRecord[];
  const rows: CanvasProjectRecord[] = [], invalidHashes: string[] = [];
  let invalid = 0;
  for (const row of found) {
    try {
      if (!row || row.scope !== scope || !/^[a-f0-9]{64}$/.test(row.outputHash) ||
        row.key !== `${scope}:${row.outputHash}` || !Number.isFinite(row.saved_at))
        throw new Error("本机画布工程记录无效。");
      validateCanvasProject(row);
      rows.push(row);
    } catch {
      invalid++;
      if (typeof row?.outputHash === "string") invalidHashes.push(row.outputHash);
    }
  }
  return { rows, invalid, invalidHashes };
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function exportBackup(owner: string, draft: Draft, projectScope?: string) {
  const rows = await gallery(owner);
  const priority = new Map<string, number>();
  const current = await projectHash(draft.parameters?.image);
  if (current) priority.set(current, 2);
  const directorSource = await projectHash(draft.director?.source?.data);
  if (directorSource) priority.set(directorSource, 2);
  for (const row of rows) {
    if (/^[a-f0-9]{64}$/.test(row.result.sha256))
      priority.set(row.result.sha256, Math.max(priority.get(row.result.sha256) ?? 0, 1));
    const used = await projectHash(row.job?.parameters?.image);
    if (used) priority.set(used, Math.max(priority.get(used) ?? 0, 1));
  }
  let found = { rows: [] as CanvasProjectRecord[], invalid: 0, invalidHashes: [] as string[] };
  let projectsUnavailable = false;
  if (projectScope) {
    try { found = await canvasProjects(projectScope); }
    catch { projectsUnavailable = true; }
  }
  const choice = selectCanvasProjectsForBackup(found.rows, priority);
  const projects = choice.selected;
  const omitted = choice.omitted + found.invalid;
  const referencedOmitted = choice.referencedOmitted + found.invalidHashes.filter(hash => (priority.get(hash) ?? 0) > 0).length;
  const images = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      blob: undefined,
      base64: await blobBase64(row.blob),
    })),
  );
  const canvas_projects = await Promise.all(projects.map(async row => ({
    outputHash: row.outputHash,
    width: row.width,
    height: row.height,
    base: { type: row.base.type, base64: await blobBase64(row.base) },
    layers: await Promise.all(row.layers.map(async layer => ({
      id: layer.id, name: layer.name, visible: layer.visible, base64: await blobBase64(layer.blob),
    }))),
  })));
  const blob = new Blob(
    [
      JSON.stringify({
        format: "nai-workbench-backup",
        version: projectScope ? 2 : 1,
        exported_at: new Date().toISOString(),
        draft,
        images,
        ...(projectScope ? { canvas_projects, canvas_projects_omitted: omitted,
          canvas_projects_referenced_omitted: referencedOmitted,
          canvas_projects_unavailable: projectsUnavailable } : {}),
      }),
    ],
    { type: "application/json" },
  );
  return { blob, projects: projects.length, omitted, referencedOmitted, projectsUnavailable };
}

const MAX_BACKUP_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_IMAGE_COUNT = 10_000;
const MAX_BACKUP_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_DECODED_BYTES = 512 * 1024 * 1024;

function backupRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function backupBase64Bytes(value: unknown, maxBytes: number, label: string) {
  const data = value;
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new Error(`${label}不是有效的 Base64 数据，导入已取消。`);
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedSize = data.length / 4 * 3 - padding;
  if (!decodedSize || decodedSize > maxBytes)
    throw new Error(`${label}超过单项大小上限，导入已取消。`);
  let binary: string;
  try { binary = atob(data); }
  catch { throw new Error(`${label}不是有效的 Base64 数据，导入已取消。`); }
  if (binary.length !== decodedSize)
    throw new Error(`${label}不是有效的 Base64 数据，导入已取消。`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function backupImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const gifSignature = String.fromCharCode(...bytes.subarray(0, 6));
    if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" &&
    ["avif", "avis"].includes(String.fromCharCode(...bytes.subarray(8, 12)))) return "image/avif";
  return undefined;
}

function normalizeImageType(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label}图片类型无效，导入已取消。`);
  const type = value.split(";", 1)[0].trim().toLowerCase();
  const normalized = type === "image/jpg" ? "image/jpeg" : type;
  if (!["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"].includes(normalized))
    throw new Error(`${label}必须是 PNG、JPEG、WebP、AVIF 或 GIF 图片，导入已取消。`);
  return normalized;
}

function assertBackupImageType(bytes: Uint8Array, declared: unknown, label: string) {
  const expected = normalizeImageType(declared, label);
  if (backupImageType(bytes) !== expected)
    throw new Error(`${label}内容与声明的图片类型不匹配，导入已取消。`);
  return expected;
}

function backupDigest(bytes: Uint8Array) {
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateBackupResult(value: unknown, jobId: string, label: string, operation: unknown) {
  if (!backupRecord(value)) throw new Error(`${label}结果记录不完整，导入已取消。`);
  const result = value;
  if (typeof result.id !== "string" || !result.id || typeof result.job_id !== "string" || result.job_id !== jobId ||
    typeof result.filename !== "string" || !result.filename || !/^[a-f0-9]{64}$/i.test(result.sha256) ||
    !Number.isSafeInteger(result.size) || result.size < 1 || !Number.isFinite(result.expires_at) ||
    typeof result.deleted !== "boolean" || typeof result.acknowledged !== "boolean" || !backupRecord(result.metadata))
    throw new Error(`${label}结果记录不完整，导入已取消。`);
  if (operation === "encode_vibe") {
    if (result.media_type !== "application/json")
      throw new Error(`${label}的 Vibe 编码类型无效，导入已取消。`);
  } else normalizeImageType(result.media_type, label);
}

function assertBackupVibeJson(bytes: Uint8Array, label: string) {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!backupRecord(value)) throw new Error("JSON 顶层必须是对象");
  } catch {
    throw new Error(`${label}不是有效的 Vibe JSON 对象，导入已取消。`);
  }
}

async function validateBackupJob(value: unknown, resultId: string, resultJobId: string, label: string) {
  if (!backupRecord(value)) throw new Error(`${label}任务记录不完整，导入已取消。`);
  const job = value;
  if (typeof job.id !== "string" || !job.id || job.id !== resultJobId ||
    typeof job.request_id !== "string" || !job.request_id ||
    !["generate", "img2img", "inpaint", "upscale", "augment", "encode_vibe"].includes(job.operation) ||
    typeof job.model !== "string" || !job.model || typeof job.prompt !== "string" ||
    typeof job.negative_prompt !== "string" || typeof job.label !== "string" ||
    !Number.isFinite(job.created_at) || !["queued", "waiting", "running", "succeeded", "failed", "unknown", "cancelled"].includes(job.status) ||
    !Array.isArray(job.results) || !Number.isFinite(job.quota_units) || job.quota_units < 0 ||
    typeof job.storage_mode !== "string" || !job.storage_mode || !Number.isFinite(job.retention_hours) || job.retention_hours < 0)
    throw new Error(`${label}任务记录不完整，导入已取消。`);
  for (const key of ["started_at", "completed_at", "retry_at", "last_data_at"]) {
    if (job[key] != null && !Number.isFinite(job[key])) throw new Error(`${label}任务时间字段无效，导入已取消。`);
  }
  if (job.retry_count != null && !Number.isSafeInteger(job.retry_count)) throw new Error(`${label}任务重试字段无效，导入已取消。`);
  if (job.error != null && typeof job.error !== "string") throw new Error(`${label}任务错误字段无效，导入已取消。`);
  if (job.execution_phase != null && !["submitting", "waiting_result", "generating"].includes(job.execution_phase))
    throw new Error(`${label}任务状态字段无效，导入已取消。`);
  await validateParameters(job.parameters, `${label}任务参数`);
  let containsResult = false;
  for (const [index, result] of job.results.entries()) {
    validateBackupResult(result, job.id, `${label}任务结果[${index}]`, job.operation);
    if (result.id === resultId) containsResult = true;
  }
  if (!containsResult) throw new Error(`${label}图片与任务结果不匹配，导入已取消。`);
}

export async function importBackup(owner: string, file: File, projectScope?: string) {
  if (!Number.isFinite(file.size) || file.size > MAX_BACKUP_FILE_BYTES)
    throw new Error("备份文件超过 1 GiB 上限，导入已取消。");
  let input: any;
  try { input = JSON.parse(await file.text()); }
  catch { throw new Error("备份文件不是有效 JSON，导入已取消。"); }
  if (!backupRecord(input) || input.format !== "nai-workbench-backup" || ![1, 2].includes(input.version) ||
    !Array.isArray(input.images) || input.images.length > MAX_BACKUP_IMAGE_COUNT)
    throw new Error("这不是受支持的工作台备份，或图片数量超过 10,000 张上限。");

  let draft: Draft | undefined;
  if (input.draft != null) {
    try { draft = await validateDraft(input.draft); }
    catch (error) {
      if (error instanceof InvalidDraftError) {
        const backupError = new Error("备份中的绘图草稿不完整或已损坏，导入已取消。");
        Object.assign(backupError, { path: error.path });
        throw backupError;
      }
      throw error;
    }
  }
  const imageRows: Record<string, any>[] = [];
  let decodedBytes = 0;
  for (const [index, value] of input.images.entries()) {
    const label = `备份图片[${index}]`;
    if (!backupRecord(value) || typeof value.id !== "string" || !value.id || typeof value.base64 !== "string" ||
      !Number.isFinite(value.stored_at) || !backupRecord(value.result))
      throw new Error(`${label}记录不完整，导入已取消。`);
    const row = value;
    const result = row.result;
    if (result.id !== row.id) throw new Error(`${label}编号与结果不匹配，导入已取消。`);
    await validateBackupJob(row.job, result.id, result.job_id, label);
    validateBackupResult(result, result.job_id, label, row.job.operation);

    const bytes = backupBase64Bytes(row.base64, MAX_BACKUP_IMAGE_BYTES, label);
    try {
      const imageType = row.job.operation === "encode_vibe"
        ? (assertBackupVibeJson(bytes, label), "application/json")
        : assertBackupImageType(bytes, result.media_type, label);
      if (bytes.length !== result.size || backupDigest(bytes) !== String(result.sha256).toLowerCase())
        throw new Error(`${label}校验失败，导入已取消。`);
      decodedBytes += bytes.length;
      if (decodedBytes > MAX_BACKUP_DECODED_BYTES)
        throw new Error("备份图片与画布素材解码后合计超过 512 MiB 上限，导入已取消。");
      imageRows.push({ row, imageType });
    } finally { bytes.fill(0); }
  }

  const canvasRows = input.version === 2 ? input.canvas_projects : [];
  if (!Array.isArray(canvasRows) || canvasRows.length > 128 || (canvasRows.length && !projectScope))
    throw new Error("备份画布工程无法导入当前连接。");
  for (const [projectIndex, row] of canvasRows.entries()) {
    const label = `备份画布工程[${projectIndex}]`;
    if (!backupRecord(row) || !/^[a-f0-9]{64}$/i.test(row.outputHash) || !backupRecord(row.base) ||
      typeof row.base.base64 !== "string" || !Array.isArray(row.layers) || row.layers.length > 6)
      throw new Error(`${label}格式无效，导入已取消。`);
    const baseBytes = backupBase64Bytes(row.base.base64, 24 * 1024 * 1024, `${label}底图`);
    let projectBytes = baseBytes.length;
    let base: Blob;
    try {
      const baseType = assertBackupImageType(baseBytes, row.base.type, `${label}底图`);
      base = new Blob([baseBytes], { type: baseType });
    } finally { baseBytes.fill(0); }
    const layers = [] as CanvasProject["layers"];
    for (const [layerIndex, layer] of row.layers.entries()) {
      if (!backupRecord(layer) || typeof layer.base64 !== "string" || !Number.isSafeInteger(layer.id) ||
        typeof layer.name !== "string" || typeof layer.visible !== "boolean")
        throw new Error(`${label}图层[${layerIndex}]无效，导入已取消。`);
      const bytes = backupBase64Bytes(layer.base64, 20 * 1024 * 1024, `${label}图层[${layerIndex}]`);
      try {
        assertBackupImageType(bytes, "image/png", `${label}图层[${layerIndex}]`);
        projectBytes += bytes.length;
        layers.push({ id: layer.id, name: layer.name, visible: layer.visible, blob: new Blob([bytes], { type: "image/png" }) });
      } finally { bytes.fill(0); }
    }
    if (decodedBytes + projectBytes > MAX_BACKUP_DECODED_BYTES)
      throw new Error("备份图片与画布素材解码后合计超过 512 MiB 上限，导入已取消。");
    const project: CanvasProject = { version: 1, width: row.width, height: row.height, base, layers };
    try { validateCanvasProject(project); }
    catch (error) { throw new Error(`${label}无效，导入已取消：${error instanceof Error ? error.message : "格式错误"}`); }
    decodedBytes += projectBytes;
  }

  // The entire backup has passed structure, content, digest, and size checks before
  // this transaction. Re-decoding is deterministic; any unexpected error aborts
  // the transaction so the import cannot leave a partial gallery or draft.
  const d = await db();
  const t = d.transaction(["images", "drafts", "removed", "canvasProjects"], "readwrite");
  const done = complete(t);
  try {
    for (const { row, imageType } of imageRows) {
      const bytes = backupBase64Bytes(row.base64, MAX_BACKUP_IMAGE_BYTES, "备份图片");
      const blob = new Blob([bytes], { type: imageType });
      bytes.fill(0);
      const { base64: _base64, blob: _blob, ...preserved } = row;
      const record: LocalImage = { ...preserved, key: `${owner}:${row.id}`, owner, blob, imported: true };
      t.objectStore("images").put(record);
      t.objectStore("removed").delete(record.key);
    }
    if (draft) t.objectStore("drafts").put({ owner, draft });
    for (const row of canvasRows) {
      const baseBytes = backupBase64Bytes(row.base.base64, 24 * 1024 * 1024, "备份画布底图");
      const baseType = normalizeImageType(row.base.type, "备份画布底图");
      const base = new Blob([baseBytes], { type: baseType });
      baseBytes.fill(0);
      const layers = row.layers.map((layer: Record<string, any>) => {
        const bytes = backupBase64Bytes(layer.base64, 20 * 1024 * 1024, "备份画布图层");
        const blob = new Blob([bytes], { type: "image/png" });
        bytes.fill(0);
        return { id: layer.id, name: layer.name, visible: layer.visible, blob };
      });
      const project: CanvasProject = { version: 1, width: row.width, height: row.height, base, layers };
      const record: CanvasProjectRecord = { ...project, scope: projectScope!, outputHash: row.outputHash,
        key: `${projectScope}:${row.outputHash}`, saved_at: Date.now() };
      t.objectStore("canvasProjects").put(record);
    }
    await done;
  } catch (error) {
    try { t.abort(); } catch { /* transaction may already have completed */ }
    await done.catch(() => {});
    throw error;
  }
  const omittedProjects = Number.isSafeInteger(input.canvas_projects_omitted) && input.canvas_projects_omitted >= 0
    ? input.canvas_projects_omitted : 0;
  const referencedOmitted = Number.isSafeInteger(input.canvas_projects_referenced_omitted) && input.canvas_projects_referenced_omitted >= 0
    ? input.canvas_projects_referenced_omitted : 0;
  return { count: imageRows.length, projects: canvasRows.length, omittedProjects, referencedOmitted,
    projectsUnavailable: input.canvas_projects_unavailable === true, draft };
}
