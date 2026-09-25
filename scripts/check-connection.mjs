// Exercise the real connection function with synthetic credentials and controlled storage.
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
const {connectionTarget}=compile('connection.ts',{'./api':api});
const tree=ts.createSourceFile('App.tsx',fs.readFileSync(new URL('../client/src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let expression;
function visit(node) {
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='connect') expression=node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node,visit);
}
visit(tree);assert.ok(expression,'App connection callback must remain covered');

const savedFetch=globalThis.fetch, requests=[];
let mode='gate', badHealth=false;
globalThis.fetch=async (url,options={})=>{
  requests.push({url,headers:options.headers});
  if(String(url).endsWith('/health')) {
    assert.equal(options.headers?.Authorization,undefined,'health detection never receives credentials');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    return Response.json({mode},{status:badHealth?503:200});
  }
  if(url==='/api/me') return Response.json({id:'gate-fixture',name:'fixture',is_admin:false,gate_quota:{imageModelScope:'all'}});
  if(url==='/api/capabilities') return Response.json({models:[]});
  throw new Error('Unexpected request target: '+url);
};
class InvalidDraftError extends Error {}
function harness({brokenDraft=false}={}) {
  const state={},failures=[],notices=[],stored=new Map([['nai-wb-base','https://old.example']]);
  const draft={operation:'generate'}, images=[{id:'existing-image'}];
  const scope={connectionTarget,Api:api.Api,GateApi:class extends api.Api {},
    generation:{current:0},syncBusy:{current:false},submitCache:{current:null},importSequence:{current:0},
    identity:{current:''},canvasScope:{current:''},apiRef:{current:null},
    settleConfirmation:()=>{},newDraft:()=>draft,migrateDirectorDraft:value=>value,
    canvasProjectScope:owner=>owner,location:{origin:'https://workbench.example'},
    notify:message=>notices.push(message),fail:error=>failures.push(error),
    sessionStorage:{setItem:()=>{},removeItem:()=>{}},
    localStorage:{setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    local:{InvalidDraftError,readDraft:async()=>{if(brokenDraft)throw new InvalidDraftError();return draft;},gallery:async()=>images},
  };
  for(const [,name] of expression.matchAll(/\b(set[A-Z]\w*)\(/g)) scope[name]=value=>{state[name]=value;};
  const code=ts.transpileModule('const connect=('+expression+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return {run:new Function(...Object.keys(scope),code+'\nreturn connect;')(...Object.values(scope)),state,failures,notices,stored,images};
}
try {
  const good=harness();await good.run('fixture-key-not-real','https://old.example');
  assert.deepEqual(good.failures,[]);assert.equal(good.state.setLoaded,true);
  assert.equal(good.stored.has('nai-wb-base'),false);
  assert.ok(requests.every(item=>String(item.url).startsWith('/')),'hidden address must receive no request');
  assert.equal(requests.filter(item=>item.headers?.Authorization).length,2);
  assert.equal(good.state.setApi.base,'');
  console.log('PASS Gate login ignores a saved external address and sends credentials only to this origin');

  requests.length=0;badHealth=true;
  const offline=harness();await offline.run('fixture-key-not-real','https://old.example');
  assert.equal(offline.failures.length,1);assert.ok(requests.every(item=>!item.headers?.Authorization));
  badHealth=false;mode='unexpected';await assert.rejects(()=>connectionTarget('https://old.example'),/服务类型无效/);
  assert.ok(requests.every(item=>!item.headers?.Authorization));
  console.log('PASS Failed or unknown local service detection never falls back to sending a Key elsewhere');

  mode='gate';const broken=harness({brokenDraft:true});await broken.run('fixture-key-not-real','');
  assert.deepEqual(broken.failures,[]);assert.equal(broken.state.setLoaded,true);
  assert.equal(broken.state.setRows,broken.images);assert.match(broken.notices[0],/图库仍保留/);
  console.log('PASS A damaged saved draft recovers without removing gallery records');

  mode='mock';const legacy=await connectionTarget('https://explicit.example/');
  assert.equal(legacy.base,'https://explicit.example');assert.equal(legacy.gate,false);
  console.log('PASS Explicit external connections remain available on the legacy local mode');
} finally {globalThis.fetch=savedFetch;}
