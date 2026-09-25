import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {gzipSync,deflateSync} from 'node:zlib';
const require=createRequire(new URL('../client/package.json',import.meta.url)), ts=require('typescript');
function compile(file,deps={}) {
  const code=ts.transpileModule(fs.readFileSync(new URL('../client/src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function('require','exports',code)(name=>deps[name]??require(name),exports);return exports;
}
const types=compile('types.ts'), modelSettings=compile('modelSettings.ts');
const m=compile('imageImport.ts',{'./types':types,'./modelSettings':modelSettings});
const raw={prompt:'中文 prompt',uc:'negative',seed:42,width:832,height:1216,steps:28,image:'do-not-import',token:'do-not-import',v4_prompt:{caption:{base_caption:'base',char_captions:[{char_caption:'character',centers:[{x:.2,y:.7}]}]}},v4_negative_prompt:{caption:{base_caption:'bad',char_captions:[{char_caption:'bad character'}]}}};
const comment=JSON.stringify(raw);
const scaled=m.parseMetadata({Comment:JSON.stringify({...raw,width:1024,height:1024,skip_cfg_above_sigma:58*Math.sqrt(128*128/(104*152))})});
assert.ok(Math.abs(scaled.settings.skip_cfg_above_sigma-58)<1e-9);
function chunk(kind,data){const buf=Buffer.alloc(data.length+12);buf.writeUInt32BE(data.length);buf.write(kind,4);data.copy(buf,8);return buf;}
const png=(kind,data)=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk(kind,data),chunk('IEND',Buffer.alloc(0))]);
for(const [kind,data] of [
  ['tEXt',Buffer.from('Comment\0'+comment)],
  ['zTXt',Buffer.concat([Buffer.from('Comment\0\0'),deflateSync(comment)])],
  ['iTXt',Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'),deflateSync(comment)])],
  ['iTXt',Buffer.from('Comment\0\0\0\0\0'+comment)],
]) {
  const metadata=m.parseMetadata(await m.pngText(png(kind,data)));
  assert.equal(metadata.prompt,'base');assert.equal(metadata.negative,'bad');assert.equal(metadata.seed,42);
  assert.deepEqual(metadata.characters,[{prompt:'character',negative_prompt:'bad character',x:.2,y:.7}]);
  assert.equal(metadata.settings.image,undefined);assert.equal(metadata.settings.token,undefined);
}
await assert.rejects(()=>m.pngText(png('zTXt',Buffer.concat([Buffer.from('Comment\0\0'),deflateSync('x'.repeat(2*1024*1024+1))]))));
await assert.rejects(()=>m.pngText(png('iTXt',Buffer.from('Comment\0\0\0invalid'))));
for(const compressed of [true,false]) {
  const data=compressed?gzipSync(JSON.stringify({Comment:comment})):Buffer.from(JSON.stringify({Comment:comment}));
  const length=Buffer.alloc(4);length.writeUInt32BE(data.length*8);
  const bytes=Buffer.concat([Buffer.from(compressed?'stealth_pngcomp':'stealth_pnginfo'),length,data]);
  const width=128,height=128,pixels=new Uint8ClampedArray(width*height*4).fill(255);let at=0;
  for(const byte of bytes)for(let bit=7;bit>=0;bit--){pixels[4*((at%height)*width+Math.floor(at/height))+3]=254+((byte>>bit)&1);at++;}
  assert.equal(m.parseMetadata(await m.stealthMetadata(pixels,width,height)).prompt,'base');
}
const draft={prompt:'old',negative:'old negative',artist:'artist',quality:'quality',model:'nai-diffusion-4-5-full',parameters:{seed:9,character_prompts:[],image:'source'}};
const metadata=m.parseMetadata({Comment:comment});
const selected=m.applyMetadata(draft,metadata,{prompt:true,negative:false,characters:true,settings:false,seed:false,append:false,cleanBrackets:false});
// Source-only official metadata must not switch a Curated image back to Full.
for (const variant of ['Full','Curated']) {
  const modelMetadata=m.parseMetadata({Source:`NovelAI Diffusion V5 ${variant}`,Description:'fixture'});
  const imported=m.applyMetadata(draft,modelMetadata,{prompt:false,negative:false,characters:false,settings:true,seed:false,append:false,cleanBrackets:false});
  assert.equal(imported.model,`nai-diffusion-5-${variant.toLowerCase()}`);
}
assert.equal(selected.prompt,'base');assert.equal(selected.negative,'old negative');assert.equal(selected.artist,'');assert.equal(selected.parameters.seed,9);assert.equal(selected.parameters.image,'source');assert.equal(draft.prompt,'old');
const cleanSource={prompt:'{blue},{red} ,sky',negative:'[bad],low',characters:[{prompt:'{face},smile',negative_prompt:'[odd] ,hair',x:.3,y:.7}],settings:{steps:30},seed:123};
const cleanOptions={prompt:true,negative:true,characters:true,settings:true,seed:true,append:true,cleanBrackets:true};
const cleaned=m.applyMetadata(draft,cleanSource,cleanOptions);
assert.equal(cleaned.prompt,'old, blue, red, sky');
assert.equal(cleaned.negative,'old negative, bad, low');
assert.deepEqual(cleaned.parameters.character_prompts,[{prompt:'face, smile',negative_prompt:'odd, hair',x:.3,y:.7}]);
assert.equal(cleaned.parameters.steps,30);assert.equal(cleaned.parameters.seed,123);
assert.equal(draft.prompt,'old');assert.equal(draft.negative,'old negative');
const untouched=m.applyMetadata(draft,cleanSource,{...cleanOptions,append:false,cleanBrackets:false});
assert.equal(untouched.prompt,cleanSource.prompt);assert.equal(untouched.negative,cleanSource.negative);
assert.notEqual(m.vibeKey('image','model',1),m.vibeKey('image','model',.5));assert.notEqual(m.vibeKey('image','model',1),m.vibeKey('image','other-model',1));
console.log('PASS image import: PNG text/compressed/international/alpha metadata, bounds, selective import, secret exclusion, cache identity');
