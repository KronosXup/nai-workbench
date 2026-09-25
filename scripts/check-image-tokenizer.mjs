// Counts captured from the actual NovelAI image prompt meters, not a second
// locally reconstructed tokenizer. No requests to NovelAI or image generation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../client/package.json',import.meta.url));
const ts=require('typescript');
const source=fs.readFileSync(new URL('../client/src/imageTokenizer.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={}; new Function('require','exports',code)(require,exports);
const originalFetch=globalThis.fetch;
const calls=[];
globalThis.fetch=async url=>{
  assert.match(url,/^\/tokenizers\/(t5|qwen|clip)\.json$/);
  calls.push(url);
  return new Response(fs.readFileSync(new URL('../client/public'+url,import.meta.url)));
};
const t5Cases=[
  ['',1], ['cat',2], ['mountain landscape, 12345',7],
  ['mountain landscape, 中文测试, 12345',13], ['中文测试',6],
  ['1girl, {red hair}, [blue eyes], 1.5::smile::',11],
  ['redhair',3], ['red{hair}',3], ['red[hair]',3], ['cat|dog',4],
  ['cat ||dog|elephant||',3], ['cat, 0::dog::',4], ['cat, -1::dog::',4],
  ['a\u0301',4], ['猫🐱',5], ['cat🐱dog',5], ['cat\n\ndog',3], ['\\{cat\\}',5],
  ['+1.5::cat::',3], ['.5::cat::',2], ['1.::cat::',2], ['1e2::cat::',4],
  ['artist:foo',6], ['<unk>',3], ['</s>',3], ['||cathedral|猫猫猫猫||',2],
  ['mountain landscape, 中文测试, 12345, very aesthetic, masterpiece, no text',21],
  ['𠀀',4], ['👩‍🎨',7], ['ＡＢＣ',5], ['cat\u00a0dog',3], ['  cat  ',4],
  ['cat | | dog',9], ['cat::',2], ['1.2::cat::, {{dog}}',4],
  [' cat',3], ['cat ',3], ['cat  dog',3], [' ',3], ['   ',3],
  ['cat\tdog',3], ['\ncat\n',4], ['cat\u200bdog',4],
];
const qwenCases=[['cat',1], ['mountain landscape, 中文测试, 12345',14],
  ['1girl, {red hair}, [blue eyes], 1.5::smile::',19], ['red{hair}',4]];
const mismatches=[];
try {
  for(const [kind,cases] of [['t5',t5Cases],['qwen',qwenCases]]){
    const tokenizer=await exports.imageTokenizer(kind);
    for(const [text,expected] of cases){
      const actual=exports.countImageTokenSegments(tokenizer,text,kind).reduce((a,b)=>a+b,0);
      if(actual!==expected) mismatches.push({kind,text,expected,actual});
    }
    assert.equal(await exports.imageTokenizer(kind),tokenizer);
  }
  assert.deepEqual(calls,['/tokenizers/t5.json','/tokenizers/qwen.json']);
  if(mismatches.length) console.error(JSON.stringify(mismatches,null,2));
  assert.equal(mismatches.length,0,'prompt meters must match captured official values');
  console.log('Image token counts match the captured T5 and Qwen prompt meters.');
} finally { globalThis.fetch=originalFetch; }
