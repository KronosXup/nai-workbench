import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../client/package.json',import.meta.url)),ts=require('typescript');
const source=fs.readFileSync(new URL('../client/src/vibeFiles.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const vibe={};new Function('require','exports',code)(require,vibe);
const model='nai-diffusion-4-5-full',image='aW1hZ2U=',encoding='ZW5jb2Rpbmc=';
const asFile=(data,name='data.naiv4vibe')=>new File([JSON.stringify(data)],name,{type:'application/json'});
const item=vibe.makeVibeFile(encoding,model,.7,.6,true);
assert.equal(item.type,'encoding');
assert.equal(vibe.resolveVibeReference(encoding,item,model,.7).value,encoding);
assert.equal(vibe.resolveVibeReference(encoding,item,model,.7).pending,false);
assert.throws(()=>vibe.resolveVibeReference(encoding,item,'nai-diffusion-4-full',.7),/不适用于/);
assert.deepEqual(await vibe.readVibeFile(asFile(item)),[item]);
await assert.rejects(()=>vibe.readVibeFile(asFile({...item,id:'0'.repeat(64)})),/校验失败/);
const imageItem=vibe.makeVibeFile(image,model,.7,.6);
assert.equal(vibe.resolveVibeReference(image,imageItem,model,.7).pending,true);
imageItem.encodings[vibe.vibeModelKey(model)]={[vibe.vibeParameterHash(.7)]:{encoding,params:{information_extracted:.7}}};
assert.equal(vibe.resolveVibeReference(image,imageItem,model,.7).value,encoding);
assert.equal(vibe.resolveVibeReference(image,imageItem,model,.8).pending,true);
const masked={...imageItem,importInfo:{model,information_extracted:.7,strength:.6,mask:'bWFzaw=='}};
assert.throws(()=>vibe.resolveVibeReference(image,masked,model,.7),/带蒙版/);
assert.throws(()=>vibe.resolveVibeReference(image,masked,model,.7,encoding),/带蒙版/,'Unmasked draft cache must not satisfy a masked reference');
masked.encodings[vibe.vibeModelKey(model)][vibe.vibeParameterHash(.7,'bWFzaw==')]={encoding,params:{information_extracted:.7,mask:'bWFzaw=='}};
assert.equal(vibe.resolveVibeReference(image,masked,model,.7).value,encoding);
assert.equal(vibe.vibeParameterHash(.7,'bWFzaw=='),createHash('sha256').update('information_extracted:0.7,mask:bWFzaw==').digest('hex'));
await assert.rejects(()=>vibe.readVibeFile(asFile({...imageItem,image:'Y29ycnVwdA=='})),/校验失败/);
const bundle={identifier:'novelai-vibe-transfer-bundle',version:1,vibes:[item,imageItem]};
assert.equal((await vibe.readVibeFile(asFile(bundle,'data.naiv4vibebundle'))).length,2);
await assert.rejects(()=>vibe.readVibeFile(asFile({...bundle,vibes:Array(17).fill(item)},'data.naiv4vibebundle')),/数量无效/);
await assert.rejects(()=>vibe.readVibeFile(new File([new Uint8Array(20*1024*1024+1)],'large.naiv4vibe')),/20 MB/);
const downloaded=vibe.vibeDownload([item,imageItem]);
assert.equal(downloaded.name,'vibe-references.naiv4vibebundle');
assert.equal((await vibe.readVibeFile(new File([downloaded.blob],downloaded.name))).length,2);
const officialShape={identifier:'novelai-vibe-transfer',version:1,type:'encoding',
  id:createHash('sha256').update(encoding).digest('hex'),encodings:{'v4-5full':{unknown:{encoding}}},
  name:'manual-format-fixture',createdAt:'2026-09-23T00:00:00.000Z'};
assert.equal((await vibe.readVibeFile(asFile(officialShape)))[0].encodings['v4-5full'].unknown.encoding,encoding);
const pngChunk=(type,data)=>{
  const result=new Uint8Array(data.length+12),view=new DataView(result.buffer);
  view.setUint32(0,data.length);result.set(new TextEncoder().encode(type),4);result.set(data,8);
  return result;
};
const png=new File([
  Uint8Array.from([137,80,78,71,13,10,26,10]),
  pngChunk('tEXt',new TextEncoder().encode(`naidata\0${Buffer.from(JSON.stringify(officialShape)).toString('base64')}`)),
  pngChunk('IEND',new Uint8Array()),
],'vibe.png',{type:'image/png'});
assert.equal((await vibe.readVibeFile(png))[0].id,officialShape.id);
await assert.rejects(()=>vibe.readVibeFile(new File([Uint8Array.from([137,80,78,71,13,10,26,10]),pngChunk('IEND',new Uint8Array())],'empty.png')),/不含 Vibe 数据/);
console.log('PASS Vibe data files: encoded direct use, model mismatch, image cache, integrity, bundle bounds and round trip');
