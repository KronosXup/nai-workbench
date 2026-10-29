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
const auth=compile('auth.ts');
const api=compile('api.ts',{'./auth':auth});
const {DISCORD_SESSION_ACCESS_TOKEN}=auth;
const {verifyGateHealth}=compile('connection.ts',{'./api':api});
const tree=ts.createSourceFile('App.tsx',fs.readFileSync(new URL('../client/src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let expression,disconnectExpression,restoreExpression;
const initializers={};
function visit(node) {
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='connect') expression=node.initializer.arguments[0].getText(tree);
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='resetConnection') disconnectExpression=node.initializer.arguments[0].getText(tree);
  if(ts.isVariableDeclaration(node)&&ts.isArrayBindingPattern(node.name)) {
    const name=node.name.elements[0]?.name?.getText(tree);
    if(['token','rememberDevice'].includes(name)) initializers[name]=node.initializer.arguments[0].getText(tree);
  }
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='restoreDraftForSession') restoreExpression=`(${node.getText(tree)})`;
  ts.forEachChild(node,visit);
}
visit(tree);assert.ok(expression,'App connection callback must remain covered');
assert.ok(restoreExpression,'Automatic session draft restore must remain covered');
const helperCode=ts.transpileModule(`const restoreDraftForSession=${restoreExpression};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const restoreDraftForSession=new Function(helperCode+'\nreturn restoreDraftForSession;')();

const savedFetch=globalThis.fetch, requests=[];
let mode='gate', badHealth=false, networkFailure=false, meStatus=200, capabilitiesStatus=200, meResponse;
globalThis.fetch=async (url,options={})=>{
  url=new URL(url,'https://workbench.example/workbench/').pathname;
  requests.push({url,headers:options.headers});
  if(url==='/workbench/api/health') {
    assert.equal(options.headers?.Authorization,undefined,'health detection never receives credentials');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    if(networkFailure) throw new TypeError('Controlled network failure');
    return Response.json({mode},{status:badHealth?503:200});
  }
  if(url==='/workbench/api/me') return meResponse ? meResponse(options) : meStatus===200
    ? Response.json({id:'gate-fixture',name:'fixture',gate_quota:{imageModelScope:'all'}})
    : Response.json({detail:'Controlled credential rejection'},{status:meStatus});
  if(url==='/workbench/api/capabilities') return capabilitiesStatus===200 ? Response.json({models:[]})
    : Response.json({detail:'Controlled capabilities failure'},{status:capabilitiesStatus});
  throw new Error('Unexpected request target: '+url);
};
class InvalidDraftError extends Error {}
function harness({brokenDraft=false,galleryError=false,sessionToken,rememberedToken}={}) {
  const state={},failures=[],notices=[],stored=new Map([['nai-wb-base','https://old.example']]);
  const session=new Map();
  if(sessionToken!==undefined) session.set('nai-wb-token',sessionToken);
  if(rememberedToken!==undefined) stored.set('nai-wb-remembered-token',rememberedToken);
  const owners={drafts:[],gallery:[],canvas:[]};
  const draft={operation:'img2img',prompt:'remember this prompt',model:'nai-diffusion-4-5-full',artist:'',quality:'',negative:'',count:2,
    parameters:{width:1200,height:800,steps:43,scale:6,seed:17,sampler:'k_euler_ancestral',n_samples:1,strength:0.7,noise:0.2,
      character_prompts:[],image:'source-image',mask:'source-mask',source_width:1234,source_height:816,
      reference_image_multiple:['vibe-image'],reference_strength_multiple:[0.4],reference_information_extracted_multiple:[0.8],
      vibe_files:[{type:'image',data:'vibe-file'}],vibe_encodings:{cache:'encoding'},character_reference_images:['character-image'],
      character_reference_descriptions:['character description'],character_reference_strengths:[0.7],character_reference_fidelities:[0.9],
      customNumber:29},director:{model:'nai-diffusion-4-5-full',tool:'lineart',prompt:'remember director settings',emotion:'neutral',defry:2,
      source:{data:'director-image',width:80,height:60,name:'director.png'},resultId:'previous-result'}}, images=[{id:'existing-image'}];
  const scope={verifyGateHealth,DISCORD_SESSION_ACCESS_TOKEN,ApiError:api.ApiError,GateApi:class extends api.Api {pending(){return false;} close(){}},
    generation:{current:0},syncBusy:{current:false},submitCache:{current:null},importSequence:{current:0},
    selectedIdRef:{current:undefined},chooseResult:id=>{scope.selectedIdRef.current=id;state.setSelectedId=id;scope.importSequence.current++;},
    identity:{current:''},canvasScope:{current:''},apiRef:{current:null},submitting:{current:false},draftRef:{current:draft},
    settleConfirmation:()=>{},newDraft:()=>draft,migrateDirectorDraft:value=>value,restoreDraftForSession,
    canvasProjectScope:(owner,key)=>{owners.canvas.push([owner,key]);return `${owner}|key-sha256:fixture`;},
    location:{origin:'https://workbench.example'},window:{confirm:()=>true},
    notify:message=>notices.push(message),fail:error=>failures.push(error),
    sessionStorage:{getItem:key=>session.get(key)??null,setItem:(key,value)=>session.set(key,value),removeItem:key=>session.delete(key)},
    localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    local:{InvalidDraftError,saveDraft:async()=>{},readDraft:async owner=>{owners.drafts.push(owner);if(brokenDraft)throw new InvalidDraftError();return draft;},
      gallery:async owner=>{owners.gallery.push(owner);if(galleryError)throw new Error('Controlled local storage failure');return images;}},
  };
  for(const [,name] of (expression+disconnectExpression).matchAll(/\b(set[A-Z]\w*)\(/g)) scope[name]=value=>{state[name]=value;};
  const code=ts.transpileModule('const connect=('+expression+');const disconnect=('+disconnectExpression+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const callbacks=new Function(...Object.keys(scope),code+'\nreturn {connect,disconnect};')(...Object.values(scope));
  const initial=()=>{
    const values={sessionStorage:scope.sessionStorage,localStorage:scope.localStorage,DISCORD_SESSION_ACCESS_TOKEN};
    for(const name of ['token','rememberDevice']) {
      assert.ok(initializers[name],`${name} initializer must remain covered`);
      const initialCode=ts.transpileModule('const initial=('+initializers[name]+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
      values[name]=new Function(...Object.keys(values),initialCode+'\nreturn typeof initial==="function" ? initial() : initial;')(...Object.values(values));
    }
    return {token:values.token,rememberDevice:values.rememberDevice};
  };
  return {run:callbacks.connect,disconnect:callbacks.disconnect,initial,state,failures,notices,stored,session,images,owners,scope};
}
try {
  const key='fixture-key-not-real';
  const good=harness();await good.run(key);
  assert.deepEqual(good.failures,[]);assert.equal(good.state.setLoaded,true);
  assert.equal(good.stored.has('nai-wb-base'),false,'successful Gate login clears the obsolete external address');
  assert.ok(requests.every(item=>String(item.url).startsWith('/workbench/api/')),'the Gate Key is sent only to same-origin API paths');
  assert.equal(requests.filter(item=>item.headers?.Authorization).length,2);
  assert.equal(good.state.setApi.base,'.');
  assert.equal(good.session.get('nai-wb-token'),key);
  assert.equal(good.stored.has('nai-wb-remembered-token'),false,'remembering a device is opt-in');
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
  const offline=harness({sessionToken:key,rememberedToken:key});await offline.run(key,true);
  assert.equal(offline.failures.length,1);assert.deepEqual(requests.map(item=>item.url),['/workbench/api/health']);
  assert.ok(requests.every(item=>!item.headers?.Authorization));
  assert.equal(offline.session.get('nai-wb-token'),key);
  assert.equal(offline.stored.get('nai-wb-remembered-token'),key);
  console.log('PASS Failed health checks stop before sending the Gate Key and preserve saved login');

  badHealth=false;
  for(const unsupported of ['nai','mock','unexpected']) {
    mode=unsupported;requests.length=0;
    await assert.rejects(()=>verifyGateHealth(),/服务类型无效/);
    assert.deepEqual(requests.map(item=>item.url),['/workbench/api/health']);
    assert.ok(requests.every(item=>!item.headers?.Authorization));
  }
  console.log('PASS Legacy and unknown service modes are rejected before credentials are sent');

  mode='gate';requests.length=0;
  const broken=harness({brokenDraft:true});await broken.run(key);
  assert.deepEqual(broken.failures,[]);assert.equal(broken.state.setLoaded,true);
  assert.equal(broken.state.setRows,broken.images);assert.match(broken.notices[0],/图库仍保留/);
  console.log('PASS A damaged saved draft recovers without removing gallery records');

  const remembered=harness();await remembered.run('  '+key+'  ',true);
  assert.equal(remembered.session.get('nai-wb-token'),key);
  assert.equal(remembered.stored.get('nai-wb-remembered-token'),key);
  assert.deepEqual(harness().initial(),{token:'',rememberDevice:false});
  assert.deepEqual(harness({rememberedToken:key}).initial(),{token:key,rememberDevice:true});
  assert.deepEqual(harness({sessionToken:key,rememberedToken:key}).initial(),{token:key,rememberDevice:true});
  assert.deepEqual(harness({sessionToken:'tab-key',rememberedToken:key}).initial(),{token:'tab-key',rememberDevice:false});
  const optOut=harness({sessionToken:key,rememberedToken:key});await optOut.run(key,false);
  assert.equal(optOut.session.get('nai-wb-token'),key);
  assert.equal(optOut.stored.has('nai-wb-remembered-token'),false);
  const otherRemembered=harness({rememberedToken:'other-device-key'});await otherRemembered.run(key,false);
  assert.equal(otherRemembered.stored.get('nai-wb-remembered-token'),'other-device-key');
  console.log('PASS Device login is opt-in, survives a new tab, and respects the current tab identity');

  networkFailure=true;
  const network=harness({sessionToken:key,rememberedToken:key});await network.run(key,true);
  assert.equal(network.failures[0].message,'Controlled network failure');
  assert.equal(network.session.get('nai-wb-token'),key);assert.equal(network.stored.get('nai-wb-remembered-token'),key);
  networkFailure=false;meStatus=503;
  const unavailable=harness({sessionToken:key,rememberedToken:key});await unavailable.run(key,true);
  assert.equal(unavailable.failures[0].status,503);
  assert.equal(unavailable.session.get('nai-wb-token'),key);assert.equal(unavailable.stored.get('nai-wb-remembered-token'),key);
  meStatus=200;
  const storage=harness({galleryError:true,sessionToken:key,rememberedToken:key});await storage.run(key,true);
  assert.equal(storage.failures[0].message,'Controlled local storage failure');
  assert.equal(storage.session.get('nai-wb-token'),key);assert.equal(storage.stored.get('nai-wb-remembered-token'),key);
  capabilitiesStatus=401;
  const capabilities=harness({sessionToken:key,rememberedToken:key});await capabilities.run(key,true);
  assert.equal(capabilities.failures[0].status,401);
  assert.equal(capabilities.session.get('nai-wb-token'),key);assert.equal(capabilities.stored.get('nai-wb-remembered-token'),key);
  capabilitiesStatus=200;
  console.log('PASS Network, service, gallery and capabilities failures do not erase a saved credential');

  for(const status of [401,403]) {
    meStatus=status;
    const rejected=harness({sessionToken:key,rememberedToken:key});await rejected.run(key,true);
    assert.equal(rejected.failures[0].status,status);
    assert.equal(rejected.session.has('nai-wb-token'),false);assert.equal(rejected.stored.has('nai-wb-remembered-token'),false);
    const unrelated=harness({sessionToken:'new-tab-key',rememberedToken:'other-device-key'});await unrelated.run(key,true);
    assert.equal(unrelated.session.get('nai-wb-token'),'new-tab-key');assert.equal(unrelated.stored.get('nai-wb-remembered-token'),'other-device-key');
  }
  meStatus=200;
  console.log('PASS Invalid and disabled credentials clear only matching saved keys');

  remembered.disconnect();
  assert.equal(remembered.session.has('nai-wb-token'),false);assert.equal(remembered.stored.has('nai-wb-remembered-token'),false);
  assert.equal(remembered.state.setUser,null);assert.equal(remembered.state.setToken,'');
  otherRemembered.disconnect();
  assert.equal(otherRemembered.session.has('nai-wb-token'),false);
  assert.equal(otherRemembered.stored.get('nai-wb-remembered-token'),'other-device-key');
  console.log('PASS Logout clears this tab and its remembered key without clearing another device identity');

  let releaseOld,oldStarted;
  const started=new Promise(resolve=>{oldStarted=resolve;});
  meResponse=async options=>{
    if(options.headers.Authorization==='Bearer '+key) {
      oldStarted();return new Promise(resolve=>{releaseOld=()=>resolve(Response.json({detail:'Old credential expired'},{status:401}));});
    }
    return Response.json({id:'gate-new',name:'new fixture',gate_quota:{imageModelScope:'all'}});
  };
  const race=harness({sessionToken:key,rememberedToken:key});
  const oldWork=race.run(key,true);await started;
  await race.run('new-key',true);releaseOld();await oldWork;
  assert.equal(race.session.get('nai-wb-token'),'new-key');assert.equal(race.stored.get('nai-wb-remembered-token'),'new-key');
  assert.equal(race.state.setUser.id,'gate-new');assert.deepEqual(race.failures,[]);
  meResponse=undefined;
  console.log('PASS An old failed login cannot clear or overwrite a newly connected identity');
} finally {globalThis.fetch=savedFetch;}
