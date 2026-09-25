import { sha256 } from '@noble/hashes/sha256';

export type VibeFileItem = {
  identifier: 'novelai-vibe-transfer';
  version: 1;
  type: 'image' | 'encoding';
  id: string;
  image?: string;
  encodings: Record<string, Record<string, { encoding: string; params?: { information_extracted: number; mask?: string } }>>;
  name?: string;
  thumbnail?: string;
  importInfo?: { model: string; information_extracted: number; strength: number; mask?: string };
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 16;
const MAX_DATA_CHARS = 16 * 1024 * 1024;
const encodingKeys: Record<string, string> = {
  'nai-diffusion-4-curated-preview': 'v4curated',
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-5-curated': 'v5curated',
  'nai-diffusion-5-full': 'v5full',
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const base64 = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_DATA_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const digest = (value: string) => Array.from(sha256(new TextEncoder().encode(value)), byte => byte.toString(16).padStart(2, '0')).join('');
export const vibeModelKey = (model: string) => encodingKeys[model];
export class VibeReferenceError extends Error {}

// Official image cache keys hash a sorted, non-null parameter string.
export function vibeParameterHash(information_extracted: number, mask?: string) {
  const parts = [`information_extracted:${information_extracted}`];
  if (mask != null) parts.push(`mask:${mask}`);
  return digest(parts.join(','));
}

function parseItem(value: unknown): VibeFileItem {
  if (!object(value) || value.identifier !== 'novelai-vibe-transfer' || value.version !== 1 || !['image', 'encoding'].includes(String(value.type))) throw new Error('Vibe 文件标识或版本无效');
  if (typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || !object(value.encodings)) throw new Error('Vibe 文件结构无效');
  const encodings: VibeFileItem['encodings'] = {};
  for (const [model, entries] of Object.entries(value.encodings)) {
    if (!/^(v4curated|v4full|v4-5curated|v4-5full|v5curated|v5full|custom)$/.test(model) || !object(entries) || Object.keys(entries).length > 32) throw new Error('Vibe 编码索引无效');
    encodings[model] = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^(unknown|[a-f0-9]{64})$/.test(key) || !object(entry) || !base64(entry.encoding)) throw new Error('Vibe 编码内容无效');
      let params: { information_extracted: number; mask?: string } | undefined;
      if (entry.params !== undefined) {
        if (!object(entry.params) || !unit(entry.params.information_extracted) || (entry.params.mask !== undefined && (typeof entry.params.mask !== 'string' || entry.params.mask.length > MAX_DATA_CHARS))) throw new Error('Vibe 编码参数无效');
        params = { information_extracted: entry.params.information_extracted as number, ...(entry.params.mask === undefined ? {} : { mask: entry.params.mask as string }) };
      }
      encodings[model][key] = { encoding: entry.encoding, ...(params ? { params } : {}) };
    }
  }
  const type = value.type as VibeFileItem['type'];
  const first = Object.values(encodings).flatMap(entries => Object.values(entries))[0];
  if (type === 'image' && (!base64(value.image) || digest(value.image) !== value.id)) throw new Error('Vibe 原图校验失败');
  if (type === 'encoding' && (!first || digest(first.encoding) !== value.id)) throw new Error('Vibe 编码校验失败');
  if (type === 'encoding' && Object.values(encodings).flatMap(entries => Object.values(entries)).some(entry => digest(entry.encoding) !== value.id)) throw new Error('Vibe 编码校验失败');
  if (value.thumbnail !== undefined && (typeof value.thumbnail !== 'string' || value.thumbnail.length > MAX_DATA_CHARS || !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(value.thumbnail))) throw new Error('Vibe 缩略图格式无效');
  let importInfo: VibeFileItem['importInfo'];
  if (value.importInfo !== undefined) {
    const info = value.importInfo;
    if (!object(info) || typeof info.model !== 'string' || !/^nai-diffusion-[\w-]{1,50}$/.test(info.model) || !unit(info.information_extracted) || !unit(info.strength) || (info.mask !== undefined && (typeof info.mask !== 'string' || info.mask.length > MAX_DATA_CHARS))) throw new Error('Vibe 导入参数无效');
    importInfo = { model: info.model, information_extracted: info.information_extracted as number, strength: info.strength as number, ...(info.mask === undefined ? {} : { mask: info.mask as string }) };
  }
  return { identifier: 'novelai-vibe-transfer', version: 1, type, id: value.id, ...(type === 'image' ? { image: value.image as string } : {}), encodings, ...(typeof value.name === 'string' ? { name: value.name.slice(0, 160) } : {}), ...(typeof value.thumbnail === 'string' ? { thumbnail: value.thumbnail } : {}), ...(importInfo ? { importInfo } : {}) };
}

async function inflatePngText(bytes: Uint8Array) {
  const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE_BYTES) throw new Error('PNG 中的 Vibe 数据超过 20 MB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function vibeDataFromPng(file: File): Promise<unknown> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 8 || bytes.slice(0, 8).join() !== '137,80,78,71,13,10,26,10')
    throw new Error('不是有效的 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) throw new Error('PNG 文件不完整');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      const zero = chunk.indexOf(0);
      if (zero > 0 && zero <= 79 && decoder.decode(chunk.subarray(0, zero)) === 'naidata') {
        let text: Uint8Array;
        if (type === 'tEXt') text = chunk.subarray(zero + 1);
        else if (type === 'zTXt') {
          if (chunk[zero + 1] !== 0) throw new Error('PNG Vibe 压缩格式无效');
          text = await inflatePngText(chunk.subarray(zero + 2));
        } else {
          const compressed = chunk[zero + 1];
          if (![0, 1].includes(compressed) || chunk[zero + 2] !== 0) throw new Error('PNG Vibe 文本格式无效');
          const languageEnd = chunk.indexOf(0, zero + 3);
          const translatedEnd = languageEnd < 0 ? -1 : chunk.indexOf(0, languageEnd + 1);
          if (translatedEnd < 0) throw new Error('PNG Vibe 文本格式无效');
          const source = chunk.subarray(translatedEnd + 1);
          text = compressed ? await inflatePngText(source) : source;
        }
        const encoded = decoder.decode(text).trim();
        if (encoded.length > MAX_FILE_BYTES || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
          throw new Error('PNG 中的 Vibe 数据无效');
        const decoded = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        if (decoded.length > MAX_FILE_BYTES) throw new Error('PNG 中的 Vibe 数据超过 20 MB');
        try { return JSON.parse(decoder.decode(decoded)); }
        catch { throw new Error('PNG 中的 Vibe 数据不是有效 JSON'); }
      }
    }
    offset += length + 12;
    if (type === 'IEND') break;
  }
  throw new Error('PNG 不含 Vibe 数据（naidata）');
}

export async function readVibeFile(file: File): Promise<VibeFileItem[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Vibe 文件超过 20 MB');
  if (!/\.(naiv4vibe|naiv4vibebundle|png)$/i.test(file.name)) throw new Error('请选择 Vibe 数据文件或带 naidata 的 PNG');
  let data: unknown;
  if (/\.png$/i.test(file.name)) data = await vibeDataFromPng(file);
  else {
    try { data = JSON.parse(await file.text()); } catch { throw new Error('Vibe 文件不是有效 JSON'); }
  }
  if (!object(data)) throw new Error('Vibe 文件结构无效');
  if (data.identifier === 'novelai-vibe-transfer') return [parseItem(data)];
  if (data.identifier !== 'novelai-vibe-transfer-bundle' || data.version !== 1 || !Array.isArray(data.vibes) || data.vibes.length < 1 || data.vibes.length > MAX_ITEMS) throw new Error('Vibe 合集结构或数量无效');
  return data.vibes.map(parseItem);
}

export function encodingFor(item: VibeFileItem, model: string, extracted: number, mask?: string): string | undefined {
  const key = vibeModelKey(model);
  if (!key || !object(item.encodings)) return undefined;
  const entries = item.encodings[key];
  return item.type === 'encoding' ? entries?.unknown?.encoding : entries?.[vibeParameterHash(extracted, mask)]?.encoding;
}

export function resolveVibeReference(imageOrEncoding: string, item: VibeFileItem | null | undefined, model: string, extracted: number, cached?: string) {
  const encoded = item ? encodingFor(item, model, extracted, item.importInfo?.mask) ?? (item.type === 'image' && !item.importInfo?.mask ? cached : undefined) : cached;
  if (item?.type === 'encoding' && !encoded) throw new VibeReferenceError('此 Vibe 编码不适用于当前模型，请切回导入时的模型');
  if (item?.type === 'image' && item.importInfo?.mask && !encoded) throw new VibeReferenceError('此 Vibe 原图带蒙版，当前模型与提取值没有可用编码');
  return { value: encoded ?? imageOrEncoding, pending: !encoded };
}

export function makeVibeFile(imageOrEncoding: string, model: string, extracted: number, strength: number, encoded = false): VibeFileItem {
  if (!base64(imageOrEncoding) || !unit(extracted) || !unit(strength)) throw new Error('Vibe 数据无效');
  const key = vibeModelKey(model);
  if (!key) throw new Error('当前模型不支持 Vibe 数据文件');
  const id = digest(imageOrEncoding);
  return { identifier: 'novelai-vibe-transfer', version: 1, type: encoded ? 'encoding' : 'image', id,
    ...(encoded ? {} : { image: imageOrEncoding }),
    encodings: encoded ? { [key]: { unknown: { encoding: imageOrEncoding } } } : {},
    name: `${id.slice(0, 6)}-${id.slice(-6)}`,
    importInfo: { model, information_extracted: extracted, strength },
  };
}

export function vibeDownload(items: VibeFileItem[]): { blob: Blob; name: string } {
  if (!items.length || items.length > MAX_ITEMS) throw new Error('Vibe 文件数量无效');
  const single = items.length === 1;
  const data = single ? items[0] : { identifier: 'novelai-vibe-transfer-bundle', version: 1, vibes: items };
  const json = JSON.stringify(data, null, 2);
  if (new Blob([json]).size > MAX_FILE_BYTES) throw new Error('Vibe 导出文件超过 20 MB');
  const basename=(items[0].name || items[0].id).replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 100);
  return { blob: new Blob([json], { type: 'application/json' }), name: single ? `${basename}.naiv4vibe` : 'vibe-references.naiv4vibebundle' };
}
