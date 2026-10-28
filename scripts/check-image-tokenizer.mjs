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
const emphasisSource=fs.readFileSync(new URL('../client/src/promptEmphasis.ts',import.meta.url),'utf8');
const emphasisCode=ts.transpileModule(emphasisSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const emphasisExports={};new Function('exports',emphasisCode)(emphasisExports);
const {promptEmphasis,emphasisBackground}=emphasisExports;
const emphasisCases=[
  '2.00::watercolor::, 1.15::warm sky::, [[forest]]',
  '{{sunlight}}, [mist], 0.5::rain::, -1::clouds::',
  '\\{literal\\} \\[literal\\] \\1.5::plain \\::',
  'first line\n{second line}\n', '山水，{日出}，[[雾]]',
  '<span>mountain</span>', '0::{'+ '{'.repeat(16000) +'quiet',
];
for(const model of ['nai-diffusion-5-full','nai-diffusion-4-5-full','nai-diffusion-3'])
  for(const text of emphasisCases)
    assert.equal(promptEmphasis(text,model).map(span=>span.text).join(''),text,'highlighting preserves every source character');
function emphasisAt(text,needle,model='nai-diffusion-5-full') {
  const at=text.indexOf(needle);assert.notEqual(at,-1);let offset=0;
  for(const span of promptEmphasis(text,model)) {offset+=span.text.length;if(offset>at)return span;}
  assert.fail('Missing emphasis span');
}
assert.equal(emphasisAt('{{sunlight}}','sunlight').weight,1.05**2);
assert.equal(emphasisAt('[[mist]]','mist').weight,1.05**-2);
assert.equal(emphasisAt('1.5::sky:: land','sky').weight,1.5);
assert.equal(emphasisAt('1.5::sky:: land','land').weight,1);
assert.equal(emphasisAt('{{sun:: moon','moon').weight,1,'bare :: closes all bracket emphasis');
assert.equal(emphasisAt('0.5::rain::','rain').weight,.5);
assert.equal(emphasisAt('-1::clouds::','clouds').weight,-1);
assert.equal(emphasisAt('\\{sun\\}','sun').weight,1);
assert.equal(emphasisAt('\\1.5::plain','plain').weight,1);
assert.equal(emphasisAt('{sun \\:: sky}','sky').weight,1.05,'escaped :: does not reset emphasis');
assert.equal(emphasisAt('\\\\{sun}','sun').weight,1.05,'an escaped backslash does not escape the following bracket');
assert.equal(emphasisAt('{1.5::sky::}','sky','nai-diffusion-3').weight,1.05,'V3 does not interpret numeric emphasis');
const reset=promptEmphasis('1.5::sky::','nai-diffusion-5-full').find(span=>span.reset);
assert.equal(reset.text,'::');assert.match(emphasisBackground(reset),/^rgba\(0, 151, 7,/);
assert.match(emphasisBackground(emphasisAt('2::sky','sky')),/^rgba\(184, 55, 0,/);
assert.match(emphasisBackground(emphasisAt('[[sky]]','sky')),/^rgba\(4, 102, 206,/);
assert.equal(emphasisBackground(emphasisAt('1.15::sky','sky')),'rgba(184, 55, 0, 0.250)');
assert.equal(emphasisBackground(emphasisAt('2::sky','sky')),'rgba(184, 55, 0, 0.600)');
assert.equal(emphasisBackground(emphasisAt('[[[[sky]]]]','sky')),'rgba(4, 102, 206, 0.275)');
assert.equal(emphasisBackground(emphasisAt('sky','sky')),undefined);
assert.doesNotMatch(emphasisBackground(emphasisAt('0::'+'{'.repeat(16000)+'sky','sky')),/NaN|Infinity/);
console.log('Prompt emphasis preserves source text and handles numeric, bracket, escaped and model-specific syntax.');
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
