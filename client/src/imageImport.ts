import { sha256 } from '@noble/hashes/sha256';
import type { CharacterPrompt, Draft, Parameters } from './types';
import { joinPrompt } from './types';
import { varietyScale } from './modelSettings';

export type ImageMetadata = { prompt?: string; negative?: string; characters?: CharacterPrompt[]; settings: Partial<Parameters>; model?: string; seed?: number };
export type ImportedImage = { name: string; data: string; width: number; height: number; metadata?: ImageMetadata; warning?: string };
export type ImportOptions = { prompt: boolean; negative: boolean; characters: boolean; settings: boolean; seed: boolean; append: boolean; cleanBrackets: boolean };
const MAX_TEXT = 2 * 1024 * 1024;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' && v.length <= 100000 ? v : undefined;
const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export function parseMetadata(values: Record<string, unknown>): ImageMetadata | undefined {
  let comment = values.Comment ?? values.comment ?? values;
  if (typeof comment === 'string') { try { comment = JSON.parse(comment); } catch { comment = {}; } }
  const p = record(comment), positive = record(record(p.v4_prompt).caption), negative = record(record(p.v4_negative_prompt).caption);
  const result: ImageMetadata = { settings: {}, prompt: text(positive.base_caption ?? p.prompt ?? p.input ?? values.Description), negative: text(negative.base_caption ?? p.uc ?? p.negative_prompt) };
  const numeric: [string, number, number, boolean][] = [['width',64,4096,true],['height',64,4096,true],['steps',1,100,true],['scale',0,30,false],['cfg_rescale',0,1,false],['strength',0,1,false],['noise',0,1,false],['uncond_scale',0,2,false],['skip_cfg_above_sigma',0,1000,false]];
  for (const [key,min,max,integer] of numeric) {
    const value=p[key];
    if (finite(value,min,max) && (!integer || Number.isInteger(value))) result.settings[key]=value;
  }
  for (const key of ['sm','sm_dyn','dynamic_thresholding','use_coords','legacy_v3_extend','prefer_brownian']) if (typeof p[key]==='boolean') result.settings[key]=p[key];
  for (const key of ['sampler','noise_schedule']) if (typeof p[key]==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(p[key] as string)) result.settings[key]=p[key];
  if (finite(p.seed,0,4294967295) && Number.isInteger(p.seed)) result.seed=p.seed as number;
  const model = text(p.model ?? values.model), source=text(values.Source) ?? '';
  if (model?.startsWith('nai-diffusion-')) result.model=model.replace(/-inpainting$/, '');
  else if (/NovelAI Diffusion V?4\.5/i.test(source)) result.model=/curated/i.test(source)?'nai-diffusion-4-5-curated':'nai-diffusion-4-5-full';
  else if (/NovelAI Diffusion V?4/i.test(source)) result.model=/curated/i.test(source)?'nai-diffusion-4-curated-preview':'nai-diffusion-4-full';
  // Source is the only model hint in some official PNGs; preserve its variant.
  else if (/NovelAI Diffusion V?5/i.test(source)) result.model=/curated/i.test(source)?'nai-diffusion-5-curated':'nai-diffusion-5-full';
  else if (/NovelAI Diffusion (?:Furry.*V?3|V?3.*Furry)/i.test(source)) result.model='nai-diffusion-furry-3';
  else if (/NovelAI Diffusion (?:Anime\s*)?V?3/i.test(source)) result.model='nai-diffusion-3';
  // PNG metadata stores the canvas-scaled API threshold; the editor uses the
  // model's base-canvas value so reusing at another size does not scale twice.
  if (typeof result.settings.skip_cfg_above_sigma === 'number' &&
      typeof result.settings.width === 'number' && typeof result.settings.height === 'number')
    result.settings.skip_cfg_above_sigma /= varietyScale(result.settings.width,result.settings.height);
  if (typeof record(p.v4_prompt).use_coords === 'boolean') result.settings.use_coords = record(p.v4_prompt).use_coords;
  if (Array.isArray(positive.char_captions)) {
    const uc = Array.isArray(negative.char_captions) ? negative.char_captions : [];
    result.characters=positive.char_captions.slice(0,32).map((item,index)=> {
      const c=record(item), center=record(Array.isArray(c.centers) ? c.centers[0] : {});
      return {prompt:text(c.char_caption) ?? '',negative_prompt:text(record(uc[index]).char_caption) ?? '',x:finite(center.x,0,1)?center.x as number:.5,y:finite(center.y,0,1)?center.y as number:.5};
    });
  }
  return result.prompt!==undefined || result.negative!==undefined || Object.keys(result.settings).length || result.seed!==undefined ? result : undefined;
}

async function inflate(data: Uint8Array, format: 'gzip' | 'deflate') {
  const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[]=[]; let size=0;
  try { while (true) { const {done,value}=await reader.read(); if(done)break;size+=value.length;if(size>MAX_TEXT)throw new Error('图片参数数据过大');chunks.push(value); } }
  finally { await reader.cancel(); }
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return bytes;
}

export async function pngText(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = Object.create(null);
  if(bytes.length<8 || bytes.slice(0,8).join()!=='137,80,78,71,13,10,26,10')return result;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decode=new TextDecoder();let total=0;
  for(let at=8;at+12<=bytes.length;) {
    const length=view.getUint32(at),type=decode.decode(bytes.slice(at+4,at+8));
    if(at+12+length>bytes.length)throw new Error('PNG 文件不完整');
    if(['tEXt','iTXt','zTXt'].includes(type)) {
      total+=length;if(total>MAX_TEXT)throw new Error('图片参数数据过大');
      const data=bytes.slice(at+8,at+8+length),zero=data.indexOf(0);
      if(zero<1 || zero>79){at+=length+12;continue;}
      const key=decode.decode(data.slice(0,zero));let value:Uint8Array;
      if(!['Comment','Description','Source','Software'].includes(key)){at+=length+12;continue;}
      if(type==='tEXt')value=data.slice(zero+1);
      else if(type==='zTXt'){if(data[zero+1]!==0)throw new Error('PNG 压缩方法无效');value=await inflate(data.slice(zero+2),'deflate');}
      else {
        const compressed=data[zero+1];if(![0,1].includes(compressed)||data[zero+2]!==0)throw new Error('PNG 压缩方法无效');let start=data.indexOf(0,zero+3);if(start<0)throw new Error('PNG 参数格式无效');start=data.indexOf(0,start+1);
        if(start<0)throw new Error('PNG 参数格式无效');
        value=compressed===1?await inflate(data.slice(start+1),'deflate'):data.slice(start+1);
      }
      if(['Comment','Description','Source','Software'].includes(key))result[key]=decode.decode(value);
    }
    at+=length+12;if(type==='IEND')break;
  }
  return result;
}

export async function stealthMetadata(pixels: Uint8ClampedArray, width: number, height: number): Promise<Record<string,unknown> | undefined> {
  // Official alpha-channel layout: column-major, MSB-first signature/bit count.
  let at=0;const capacity=width*height;
  const byte=()=>{let n=0;for(let i=0;i<8;i++){if(at>=capacity)throw new Error('隐藏参数不完整');const index=4*((at%height)*width+Math.floor(at/height))+3;n=n*2+(pixels[index]&1);at++;}return n;};
  if(capacity<152)return;
  const signature=String.fromCharCode(...Array.from({length:15},byte));
  if(signature!=='stealth_pngcomp' && signature!=='stealth_pnginfo')return;
  const bits=byte()*16777216+byte()*65536+byte()*256+byte();
  if(bits<=0 || bits%8 || bits>capacity-at || bits/8>MAX_TEXT)throw new Error('隐藏参数大小无效');
  const data=Uint8Array.from({length:bits/8},byte);
  const value=new TextDecoder().decode(signature.endsWith('comp')?await inflate(data,'gzip'):data);
  return record(JSON.parse(value));
}

export async function readImage(file: File): Promise<ImportedImage> {
  if(file.size>20*1024*1024)throw new Error('单张图片最多 20 MB');
  if(!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name))throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  const bitmap=await createImageBitmap(file);
  try {
    const {width,height}=bitmap;if(width*height>20_000_000 || width<1 || height<1)throw new Error('图片最多 2000 万像素');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(bitmap,0,0);
    let metadata:ImageMetadata|undefined,warning:string|undefined;
    try {
      metadata=parseMetadata(await pngText(new Uint8Array(await file.arrayBuffer())));
      if(!metadata)metadata=parseMetadata(await stealthMetadata(context.getImageData(0,0,width,height).data,width,height) ?? {});
    } catch { warning='图片可以使用，但其中的参数无法完整读取。'; }
    const data=canvas.toDataURL('image/png').split(',')[1];
    if(data.length>20*1024*1024)throw new Error('图片转换后过大，请缩小尺寸后再导入');
    return {name:file.name,width,height,data,metadata,warning};
  } finally {bitmap.close();}
}

export function applyMetadata(draft: Draft, data: ImageMetadata, options: ImportOptions): Draft {
  const d=structuredClone(draft),p=d.parameters;
  // Match the official Clean Imports option on imported text only. Existing
  // draft text, generation settings and seed must remain untouched.
  const importedText=(value:string)=>options.cleanBrackets
    ? value.replace(/[[\]{}]/g,'').replace(/,(?=[^ ])/g,', ').replace(/ ,/g,',')
    : value;
  if(options.prompt && data.prompt!==undefined) {
    const prompt=importedText(data.prompt);
    d.prompt=options.append?joinPrompt(d.prompt,prompt):prompt;
    if(!options.append){d.artist='';d.quality='';d.qualityPreset='none';d.furryMode=false;}
  }
  if(options.negative && data.negative!==undefined){const negative=importedText(data.negative);d.negative=options.append?joinPrompt(d.negative,negative):negative;if(!options.append)d.ucPreset="none";}
  if(options.characters && data.characters){
    const characters=data.characters.map(character=>({
      ...character,prompt:importedText(character.prompt),negative_prompt:importedText(character.negative_prompt),
    }));
    p.character_prompts=options.append?[...p.character_prompts,...characters]:characters;
  }
  if(options.settings){Object.assign(p,data.settings);if(data.model)d.model=data.model;}
  if(options.seed && data.seed!==undefined)p.seed=data.seed;
  return d;
}

export const vibeKey=(image:string,model:string,extracted:number)=>Array.from(sha256(new TextEncoder().encode(`${model}|${extracted}|${image}`)),n=>n.toString(16).padStart(2,'0')).join('');
