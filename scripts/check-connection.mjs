// Exercise same-origin Gate connection and local-data recovery with controlled storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../client/package.json',import.meta.url));
const ts=require('typescript');
function compile(file,deps={}) {
  const source=fs.readFileSync(new URL('../client/src/'+file,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function('require','exports',code)(name=>deps[name]??require(name),exports);return exports;
}
const api=compile('api.ts');
const {verifyGateHealth}=compile('connection.ts',{'./api':api});
const tree=ts.createSourceFile('App.tsx',fs.readFileSync(new URL('../client/src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let expression,restoreExpression;
function visit(node) {
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='connect') expression=node.initializer.arguments[0].getText(tree);
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='restoreDraftForSession') restoreExpression=`(${node.getText(tree)})`;
  ts.forEachChild(node,visit);
}
visit(tree);assert.ok(expression,'App connection callback must remain covered');
assert.ok(restoreExpression,'Automatic session draft restore must remain covered');
const helperCode=ts.transpileModule(`const restoreDraftForSession=${restoreExpression};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const restoreDraftForSession=new Function(helperCode+'\nreturn restoreDraftForSession;')();

const savedFetch=globalThis.fetch, requests=[];
let mode='gate', badHealth=false;
globalThis.fetch=async (url,options={})=>{
  requests.push({url,headers:options.headers});
  if(url==='/api/health') {
    assert.equal(options.headers?.Authorization,undefined,'health detection never receives credentials');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    return Response.json({mode},{status:badHealth?503:200});
  }
  if(url==='/api/me') return Response.json({id:'gate-fixture',name:'fixture',gate_quota:{imageModelScope:'all'}});
  if(url==='/api/capabilities') return Response.json({models:[]});
  throw new Error('Unexpected request target: '+url);
};
class InvalidDraftError extends Error {}
function harness({brokenDraft=false}={}) {
  const state={},failures=[],notices=[],stored=new Map([['nai-wb-base','https://old.example']]);
  const owners={drafts:[],gallery:[],canvas:[]};
  const draft={operation:'img2img',prompt:'remember this prompt',model:'nai-diffusion-4-5-full',artist:'',quality:'',negative:'',count:2,
    parameters:{width:1200,height:800,steps:43,scale:6,seed:17,sampler:'k_euler_ancestral',n_samples:1,strength:0.7,noise:0.2,
      character_prompts:[],image:'source-image',mask:'source-mask',source_width:1234,source_height:816,
      reference_image_multiple:['vibe-image'],reference_strength_multiple:[0.4],reference_information_extracted_multiple:[0.8],
      vibe_files:[{type:'image',data:'vibe-file'}],vibe_encodings:{cache:'encoding'},character_reference_images:['character-image'],
      character_reference_descriptions:['character description'],character_reference_strengths:[0.7],character_reference_fidelities:[0.9],
      customNumber:29},director:{model:'nai-diffusion-4-5-full',tool:'lineart',prompt:'remember director settings',emotion:'neutral',defry:2,
      source:{data:'director-image',width:80,height:60,name:'director.png'},resultId:'previous-result'}}, images=[{id:'existing-image'}];
  const scope={verifyGateHealth,GateApi:class extends api.Api {},
    generation:{current:0},syncBusy:{current:false},submitCache:{current:null},importSequence:{current:0},
    identity:{current:''},canvasScope:{current:''},apiRef:{current:null},
    settleConfirmation:()=>{},newDraft:()=>draft,migrateDirectorDraft:value=>value,restoreDraftForSession,
    canvasProjectScope:(owner,key)=>{owners.canvas.push([owner,key]);return `${owner}|key-sha256:fixture`;},
    location:{origin:'https://workbench.example'},
    notify:message=>notices.push(message),fail:error=>failures.push(error),
    sessionStorage:{setItem:()=>{},removeItem:()=>{}},
    localStorage:{setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    local:{InvalidDraftError,readDraft:async owner=>{owners.drafts.push(owner);if(brokenDraft)throw new InvalidDraftError();return draft;},
      gallery:async owner=>{owners.gallery.push(owner);return images;}},
  };
  for(const [,name] of expression.matchAll(/\b(set[A-Z]\w*)\(/g)) scope[name]=value=>{state[name]=value;};
  const code=ts.transpileModule('const connect=('+expression+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return {run:new Function(...Object.keys(scope),code+'\nreturn connect;')(...Object.values(scope)),state,failures,notices,stored,images,owners,scope};
}
try {
  const key='fixture-key-not-real';
  const good=harness();await good.run(key);
  assert.deepEqual(good.failures,[]);assert.equal(good.state.setLoaded,true);
  assert.equal(good.stored.has('nai-wb-base'),false,'successful Gate login clears the obsolete external address');
  assert.ok(requests.every(item=>String(item.url).startsWith('/api/')),'the Gate Key is sent only to same-origin API paths');
  assert.equal(requests.filter(item=>item.headers?.Authorization).length,2);
  assert.equal(good.state.setApi.base,'');
  const owner='https://workbench.example|gate-fixture';
  assert.deepEqual(good.owners.drafts,[owner]);
  assert.deepEqual(good.owners.gallery,[owner]);
  assert.deepEqual(good.owners.canvas,[[owner,key]],'canvas scope keeps the existing site and Key identity');
  assert.equal(good.state.setDraft.operation,'generate','connect resets a source-dependent operation after removing its source');
  assert.equal(good.state.setDraft.prompt,'remember this prompt');
  for(const [name,value] of Object.entries({width:1200,height:800,steps:43,scale:6,seed:17,customNumber:29}))
    assert.equal(good.state.setDraft.parameters[name],value,`${name} remains in the connected draft`);
  for(const name of ['image','mask','source_width','source_height','vibe_files','vibe_encodings'])
    assert.equal(Object.hasOwn(good.state.setDraft.parameters,name),false,`${name} is cleared during connect`);
  for(const name of ['reference_image_multiple','reference_strength_multiple','reference_information_extracted_multiple',
    'character_reference_images','character_reference_descriptions','character_reference_strengths','character_reference_fidelities'])
    assert.deepEqual(good.state.setDraft.parameters[name],[],`${name} is cleared during connect`);
  assert.equal(good.state.setDraft.director.source,undefined);
  assert.equal(good.state.setDraft.director.prompt,'remember director settings');
  console.log('PASS Gate login validates same-origin health, ignores and clears the old address, and keeps the local identity namespace');

  requests.length=0;badHealth=true;
  const offline=harness();await offline.run(key);
  assert.equal(offline.failures.length,1);assert.deepEqual(requests.map(item=>item.url),['/api/health']);
  assert.ok(requests.every(item=>!item.headers?.Authorization));
  console.log('PASS Failed health checks stop before sending the Gate Key');

  badHealth=false;
  for(const unsupported of ['nai','mock','unexpected']) {
    mode=unsupported;requests.length=0;
    await assert.rejects(()=>verifyGateHealth(),/服务类型无效/);
    assert.deepEqual(requests.map(item=>item.url),['/api/health']);
    assert.ok(requests.every(item=>!item.headers?.Authorization));
  }
  console.log('PASS Legacy and unknown service modes are rejected before credentials are sent');

  mode='gate';requests.length=0;
  const broken=harness({brokenDraft:true});await broken.run(key);
  assert.deepEqual(broken.failures,[]);assert.equal(broken.state.setLoaded,true);
  assert.equal(broken.state.setRows,broken.images);assert.match(broken.notices[0],/图库仍保留/);
  console.log('PASS A damaged saved draft recovers without removing gallery records');
} finally {globalThis.fetch=savedFetch;}
