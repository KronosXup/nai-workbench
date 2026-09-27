// Runs the actual App functions against controlled storage/network boundaries.
// This is a logic regression check, not a replacement for browser/IndexedDB QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'client', 'package.json'));
const ts = require('typescript');
const sourcePath = path.join(root, 'client', 'src', 'App.tsx');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(
  sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

function actualModule(name) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'client', 'src', name), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  new Function('exports', 'require', compiled)(exports, name =>
    name.startsWith('.') ? actualModule(name.replace('./','') + '.ts') : require(name));
  return exports;
}
const {configurationIssueFor, effectiveModelForOperation, usesGenerationSettings} = actualModule('taskValidation.ts');
const {ApiError} = actualModule('api.ts');
const {generationParameters, defaultNoiseSchedule, modelGenerationDefaults} = actualModule('modelSettings.ts');
const {composePrompts} = actualModule('promptPresets.ts');
const {newDraft, defaultParameters, joinPrompt, uuid} = actualModule('types.ts');
const {resolveVibeReference, makeVibeFile, VibeReferenceError, encodingFor} = actualModule('vibeFiles.ts');
const {readDirectorDraft, directorFromJob, directorTask, directorMatchesJob, directorSourceIssue, migrateDirectorDraft} = actualModule('director.ts');

function actualFunction(name, scope) {
  scope = {effectiveModelForOperation, ...scope};
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = `(${node.getText(source)})`;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const init = node.initializer;
      if (init && ts.isCallExpression(init) && init.expression.getText(source) === 'useCallback') {
        expression = `(${init.arguments[0].getText(source)})`;
      } else if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        expression = `(${init.getText(source)})`;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `Cannot find actual ${name} in App.tsx; update the harness if the function moved.`);
  const compiled = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
  }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn extracted;`)(...Object.values(scope));
}

function quoteHarness() {
  const state = {draft: newDraft(), page: 'draw', quote: null, error: null, requests: [], failure: null};
  const models = [
    {id:'nai-diffusion-4-5-full', max_characters:6, precise_reference:true, vibe_transfer:true},
    {id:'nai-diffusion-5-full', max_characters:8, precise_reference:false, vibe_transfer:false},
  ];
  const scope = {
    caps: {models, operations:['generate','img2img','inpaint','upscale','augment','encode_vibe']},
    readDirectorDraft, directorSourceIssue, directorFromJob,
    fallbackModels: models, configurationIssueFor, usesGenerationSettings, ApiError, generationParameters, composePrompts,
    generation: {current:1}, quoteVersion: {current:0}, uuid, joinPrompt,
    resolveVibeReference, VibeReferenceError, vibeKey:(image,model,extracted)=>`${image}|${model}|${extracted}`,
    stringKeys: ['artist','quality','negative'],
    draftRef: {current: state.draft},
    setDraft: change => {
      state.draft = typeof change === 'function' ? change(state.draft) : change;
      scope.draftRef.current = state.draft;
    },
    setQuote: quote => { state.quote = quote; },
    setQuoteError: error => { state.error = error; },
    errorText: error => error.message, fail: error => { state.failure = error; },
    setPage: page => { state.page = page; }, setMobileTab: () => {}, notify: () => {},
    api: {request: async (route, task) => {
      state.requests.push({route, task});
      if (state.responseError) throw state.responseError;
      return {units:0, unit_label:'积分', verified:false, message:'Fixture estimate'};
    }},
  };
  // Each extraction represents a fresh render, so closures see the current draft.
  const fn = name => {
    const render = {...scope, draft:state.draft, page:state.page};
    render.patchDirector = actualFunction('patchDirector', render);
    render.openDirector = actualFunction('openDirector', render);
    render.taskFor = actualFunction('taskFor', render);
    render.batchStrings = actualFunction('batchStrings', render);
    return actualFunction(name, render);
  };
  return {state, scope, fn};
}

function harness() {
  const result = {
    id: 'fixture-result', job_id: 'fixture-job', sha256: 'a'.repeat(64),
    deleted: false, acknowledged: false, media_type: 'image/png', metadata: {},
  };
  const job = {id: 'fixture-job', operation: 'generate', created_at: 1, completed_at: 2, status: 'succeeded', prompt: 'Owner A prompt', results: [result]};
  const state = {records: new Map(), removed: new Set(), rows: [], jobs: [], saveIssue: null, draft: {prompt: 'Owner A draft'}, errors: [], downloads: 0};
  const owner = 'http://fixture|A';
  const scope = {
    api: null,
    draftRef: {get current() { return state.draft; }},
    pageRef: {current: 'draw'}, readDirectorDraft, directorMatchesJob, migrateDirectorDraft,
    user: {id: 'A'},
    identity: {current: owner},
    canvasScope: {current: `${owner}|key-sha256:${'a'.repeat(64)}`},
    generation: {current: 1},
    importSequence: {current: 0},
    syncBusy: {current: false},
    selectedIdRef: {get current() { return state.selectedId; }, set current(value) { state.selectedId = value; }},
    askConfirmation: async () => true,
    errorText: error => error instanceof Error ? error.message : String(error),
    setJobs: value => { state.jobs = typeof value === 'function' ? value(state.jobs) : value; },
    setSaveIssue: value => { state.saveIssue = typeof value === 'function' ? value(state.saveIssue) : value; },
    setUser: () => {},
    setSyncing: () => {},
    setQueuePaused: () => {},
    setQueueEncoding: () => {},
    setEncodingPaused: () => {},
    setEncodingRetryAt: () => {},
    setEncodingWaitReason: () => {},
    setQueueNow: () => {},
    setBlankCanvas: () => {},
      setSelectedId: id => { state.selectedId = id; },
      chooseResult: id => { scope.selectedIdRef.current = id; scope.importSequence.current++; state.selectedId = id; },
    setRows: rows => { state.rows = rows; },
    setDraft: draft => { state.draft = typeof draft === 'function' ? draft(state.draft) : draft; },
    notify: () => {},
    fail: error => { state.errors.push(error); },
    local: {
      orderBackupFiles: files => files,
      getImage: async (identity, id) => state.records.get(`${identity}:${id}`),
      isRemoved: async (identity, id) => state.removed.has(`${identity}:${id}`),
      storeResult: async (identity, inputJob, inputResult, blob) => {
        if (state.removed.has(`${identity}:${inputResult.id}`)) return undefined;
        const record = {
          owner: identity, id: inputResult.id, blob,
          job: structuredClone(inputJob), result: structuredClone(inputResult),
        };
        state.records.set(`${identity}:${inputResult.id}`, record);
        return record;
      },
      removeImage: async (identity, id) => {
        state.records.delete(`${identity}:${id}`);
        state.removed.add(`${identity}:${id}`);
      },
      gallery: async identity => [...state.records.values()].filter(row => row.owner === identity),
      digest: async () => result.sha256,
    },
  };
  scope.api = {
    content: async () => { state.downloads++; return new Blob(['fixture']); },
    request: async route => {
      if (route === '/jobs') return {jobs: [structuredClone(job)]};
      if (route === '/me') return {id: 'A'};
      if (route.endsWith('/ack')) {
        result.acknowledged = true;
        return {acknowledged: true, deleted: false};
      }
      throw new Error(`Unmodelled API boundary: ${route}`);
    },
  };
  return {
    scope, state, result, job,
    fn: name => actualFunction(name, scope),
    switchToB() {
      scope.generation.current++;
      scope.identity.current = 'http://fixture|B';
      scope.canvasScope.current = `http://fixture|B|key-sha256:${'b'.repeat(64)}`;
      state.rows = [];
      state.saveIssue = null;
      state.draft = {prompt: 'Owner B draft'};
    },
  };
}

const checks = [
  ['Cancelling a pending regular image import preserves the current source and ignores its late decode', async () => {
    const h=harness();
    const original={...newDraft(),parameters:{...defaultParameters,image:'previous-source',mask:'previous-mask',width:832,height:1216}};
    h.scope.draftRef={current:original};
    let finish; const imported=[];
    Object.assign(h.scope,{user:{id:'A'},pageRef:{current:'draw'},importSequence:{current:0},
      readImage:()=>new Promise(resolve=>{finish=resolve;}),setImports:value=>{imported.push(value);},setDragging:()=>{},
      generation:{current:1},identity:{current:'owner-a'}});
    const work=h.fn('openImages')([{name:'replacement.png'}]);
    h.scope.importSequence.current++;
    h.scope.setImports([]);
    finish({name:'replacement.png',data:'new-source',width:64,height:64});
    await work;
    assert.equal(h.scope.draftRef.current,original,'Cancelling selection leaves all draft attachments untouched');
    assert.deepEqual(imported,[[]],'The late image decode must not reopen the chooser');

    let draft=original;
    const acceptanceScope={draftRef:{get current(){return draft;}},effectiveModelForOperation,usesGenerationSettings,
      setDraft:change=>{draft=typeof change==='function'?change(draft):change;},setPage:()=>{},setMobileTab:()=>{},notify:()=>{},
      setPendingMaskDraft:()=>{},setShowMask:()=>{},openDirector:()=>{}};
    actualFunction('acceptImage',acceptanceScope)('image',{name:'replacement.png',data:'new-source',width:832,height:1216});
    assert.equal(draft.parameters.image,'new-source','Choosing Image2Image applies the newly selected source');
    assert.equal(draft.parameters.mask,undefined,'Replacing a source clears its old mask only after selection');
    assert.equal(draft.prompt,original.prompt); assert.equal(draft.negative,original.negative);
  }],
  ['Generation settings reset confirms, keeps prompt and images, and rejects stale drafts', async () => {
    const original = newDraft();
    original.model = 'nai-diffusion-4-5-full';
    original.prompt = 'keep positive'; original.negative = 'keep negative'; original.qualityPreset = 'light';
    original.parameters = {...original.parameters, image:'keep-source', mask:'keep-mask', steps:47, scale:9, seed:12,
      character_prompts:[{prompt:'keep character',negative_prompt:'keep character negative',x:.2,y:.8}], reference_image_multiple:['keep-vibe']};
    const state={draft:original,request:null}; let accept;
    const scope={draftRef:{get current(){return state.draft;}},generation:{current:4},identity:{current:'owner-a'},
      effectiveModelForOperation,modelGenerationDefaults,
      askConfirmation:request=>{state.request=request;return new Promise(resolve=>{accept=resolve;});},
      setDraft:change=>{state.draft=typeof change==='function'?change(state.draft):change;}};
    const reset=actualFunction('resetGenerationSettings',scope);
    const work=reset();
    assert.equal(state.request.title,'重置生成设置？');
    assert.match(state.request.message,/质量预设恢复为“标准”/);
    accept(false); await work;
    assert.equal(state.draft,original,'Cancel must not replace or patch the draft');

    const accepted=reset(); accept(true); await accepted;
    assert.equal(state.draft.qualityPreset,'standard');
    assert.deepEqual(state.draft.parameters,{...original.parameters,...modelGenerationDefaults('nai-diffusion-4-5-full')});
    assert.equal(state.draft.prompt,'keep positive'); assert.equal(state.draft.negative,'keep negative');
    assert.equal(state.draft.parameters.image,'keep-source'); assert.equal(state.draft.parameters.mask,'keep-mask');
    assert.deepEqual(state.draft.parameters.reference_image_multiple,['keep-vibe']);
    assert.deepEqual(state.draft.parameters.character_prompts,original.parameters.character_prompts);

    const fresh={...original,model:'nai-diffusion-5-full',prompt:'newer draft'};
    state.draft=original; const stale=reset(); state.draft=fresh; accept(true); await stale;
    assert.equal(state.draft,fresh,'A draft replacement during confirmation must win');
    state.draft=original; const switched=reset(); scope.generation.current++; accept(true); await switched;
    assert.equal(state.draft,original,'A model/account generation change during confirmation must block reset');
  }],
  ['Mask save preserves editable source and draft fields, applies pending mask draft, and rejects stale async saves', async () => {
    const base=newDraft(); base.prompt='base prompt'; base.negative='base negative';
    base.parameters={...base.parameters,image:'old-source',mask:'old-mask',reference_image_multiple:['ref'],custom_field:{keep:true}};
    const pending={...base,prompt:'pending prompt',parameters:{...base.parameters,image:'pending-source'}};
    const state={draft:base,pendingMaskDraft:pending,saved:[],page:'mask',mobile:'result',closed:false};
    const scope={generation:{current:8},identity:{current:'owner-a'},canvasScope:{current:'scope-a'},draftRef:{get current(){return state.draft;}},
      pendingMaskDraft:pending,CanvasProject:undefined,local:{saveCanvasProject:async(...args)=>{state.saved.push(args);}},
      setDraft:change=>{state.draft=typeof change==='function'?change(state.draft):change;},closeMask:()=>{state.closed=true;state.pendingMaskDraft=null;},
      setPage:value=>{state.page=value;},setMobileTab:value=>{state.mobile=value;},notify:()=>{}};
    await actualFunction('saveMask',scope)('new-mask');
    assert.equal(state.draft.parameters.image,'pending-source');
    assert.equal(state.draft.parameters.mask,'new-mask');
    assert.equal(state.draft.prompt,'pending prompt');
    assert.equal(state.draft.negative,'base negative');
    assert.deepEqual(state.draft.parameters.reference_image_multiple,['ref']);
    assert.deepEqual(state.draft.parameters.custom_field,{keep:true});
    assert.deepEqual(state.saved,[],'A binary mask update without edited source must not save/rewrite the source image');
    assert.equal(state.closed,true);

    const unchanged={...base,parameters:{...base.parameters}};
    state.draft=unchanged; state.pendingMaskDraft=null; scope.pendingMaskDraft=null; state.closed=false;
    await actualFunction('saveMask',scope)('mask-only');
    assert.equal(state.draft.parameters.image,'old-source','Mask-only edits retain the original source');
    assert.equal(state.draft.parameters.mask,'mask-only');

    state.draft=base; state.pendingMaskDraft=null; scope.pendingMaskDraft=null; state.closed=false;
    scope.local.saveCanvasProject=async(...args)=>{state.saved.push(args);};
    await actualFunction('saveMask',scope)('edited-mask','edited-source',{id:'editable-project'});
    assert.equal(state.draft.parameters.image,'edited-source','A flattened edited source is paired with its new mask');
    assert.equal(state.draft.parameters.mask,'edited-mask');
    assert.equal(state.draft.prompt,'base prompt'); assert.equal(state.draft.negative,'base negative');
    assert.deepEqual(state.draft.parameters.reference_image_multiple,['ref']);
    assert.deepEqual(state.draft.parameters.custom_field,{keep:true});
    assert.equal(state.saved.at(-1)[1],'edited-source');

    state.draft=base; state.pendingMaskDraft=pending; scope.pendingMaskDraft=pending; state.closed=false;
    let finishSave; scope.local.saveCanvasProject=async(...args)=>{state.saved.push(args);await new Promise(resolve=>{finishSave=resolve;});};
    const staleWork=actualFunction('saveMask',scope)('raced-mask','edited-source',{id:'project'});
    await Promise.resolve();
    state.draft={...base,prompt:'new draft after save started'};
    finishSave();
    await assert.rejects(staleWork,/当前草稿已改变/);
    assert.equal(state.draft.prompt,'new draft after save started','An async canvas save must not overwrite a newer draft');
  }],
  ['App accepts only a same-origin Gate connection', async () => {
    assert.match(sourceText, /await verifyGateHealth\(\)/);
    assert.match(sourceText, /new GateApi\("", access\.trim\(\)\)/);
    assert.doesNotMatch(sourceText, /\bisGate\b|\bisMock\b|\bloginBase\b|new Api\(/);
    assert.doesNotMatch(sourceText, /StorageSettings|\/admin\/users|["']\/settings/);
  }],
  ['Logout during pending work clears busy for the next login', async () => {
    const state = {busy:true, user:{id:'A'}, draft:newDraft(), loaded:true, token:'old-key'};
    const api = {pending:()=>true, close:()=>{state.closed=true;}};
    const noop = () => {};
    const scope = {
      apiRef:{current:api}, window:{confirm:()=>true}, settleConfirmation:noop,
      local:{saveDraft:async()=>{}, readDraft:async()=>undefined, gallery:async()=>[]},
      generation:{current:7}, submitting:{current:true}, identity:{current:'https://fixture|A'},
      canvasScope:{current:'scope-A'}, submitCache:{current:{fingerprint:'old'}}, importSequence:{current:2},
      syncBusy:{current:true}, draftRef:{current:state.draft}, newDraft,
      setBusy:value=>{state.busy=value;}, setUser:value=>{state.user=value;},
      setDraft:value=>{state.draft=typeof value==='function'?value(state.draft):value;},
      setLoaded:value=>{state.loaded=value;}, setToken:value=>{state.token=value;},
      setConnecting:noop, setFailure:noop, setUserRefreshIssue:noop, setBackupWarning:noop,
      setImports:noop, setDragging:noop, setApi:noop, setCaps:noop, setRows:noop, setJobs:noop,
      setSaveIssue:noop, setQueuePaused:noop, setQueueEncoding:noop, setEncodingPaused:noop,
      setEncodingRetryAt:noop, setEncodingWaitReason:noop, setBlankCanvas:noop,
      setPendingMaskDraft:noop, setShowMask:noop, setCanvasInput:noop, setPixelInput:noop,
      setSelectedId:noop, setQuote:noop, setQuoteError:noop, setLoginToken:noop,
      chooseResult:noop,
      setNotice:noop, notify:noop, fail:error=>{throw error;},
      sessionStorage:{removeItem:noop,setItem:noop}, localStorage:{removeItem:noop},
      location:{origin:'https://fixture'}, fallbackModels:[], verifyGateHealth:async()=>{},
      canvasProjectScope:()=> 'scope-B', restoreDraftForSession:actualFunction('restoreDraftForSession'),
      migrateDirectorDraft,
      GateApi:class { async request(route) {
        if(route==='/me') return {id:'B',name:'Owner B',quota:{remaining:5}};
        if(route==='/capabilities') return {models:[],operations:[]};
        throw new Error(`Unmodelled connection request: ${route}`);
      } },
    };
    actualFunction('disconnect',scope)();
    assert.equal(state.closed,true);
    assert.equal(state.busy,false,'confirmed logout must clear the abandoned submission spinner');
    assert.equal(scope.submitting.current,false,'a new session must not inherit the old submit guard');
    await actualFunction('connect',scope)('new-key');
    assert.equal(state.user.id,'B');
    assert.equal(state.busy,false,'re-login remains able to submit after pending work was abandoned');
  }],
  ['Background account refresh keeps cached data, reports locally and backs off after failures', async () => {
    let current = {id:'A', name:'Owner A', quota:{remaining:42}}, refreshIssue = false;
    const generation = {current:7};
    const setUser = change => { current = typeof change === 'function' ? change(current) : change; };
    const setRefreshIssue = value => { refreshIssue = typeof value === 'function' ? value(refreshIssue) : value; };
    const refresh = actualFunction('refreshUserSnapshot');
    assert.equal(await refresh({request:async () => { throw new Error('temporary network failure'); }}, 7, generation, () => false, setUser, setRefreshIssue), false);
    assert.deepEqual(current, {id:'A', name:'Owner A', quota:{remaining:42}}, 'a failed poll retains the last account snapshot');
    assert.equal(refreshIssue, true, 'failure is exposed through the local account status');

    const cached = current;
    const recovered = actualFunction('refreshUserSnapshot');
    assert.equal(await recovered({request:async () => structuredClone(cached)}, 7, generation, () => false, setUser, setRefreshIssue), true);
    assert.equal(current, cached, 'unchanged account data does not force another App update');
    assert.equal(refreshIssue, false, 'a successful refresh clears the local warning');

    const stale = actualFunction('refreshUserSnapshot');
    assert.equal(await stale({request:async () => ({id:'B'})}, 6, generation, () => false, setUser, setRefreshIssue), false);
    assert.equal(current, cached, 'a stale response cannot replace the current account');
    assert.equal(refreshIssue, false);

    const delay = actualFunction('accountRefreshDelay', {
      ACCOUNT_REFRESH_INTERVAL_MS:5_000,
      ACCOUNT_REFRESH_RETRY_BASE_MS:15_000,
      ACCOUNT_REFRESH_RETRY_MAX_MS:300_000,
    });
    assert.equal(delay(0), 5_000);
    assert.equal(delay(1), 15_000);
    assert.equal(delay(2), 30_000);
    assert.equal(delay(6), 300_000, 'repeated failures cap the retry delay at five minutes');
  }],
  ['The streaming setting controls the next request without changing earlier task snapshots', async () => {
    const h = quoteHarness();
    const previous = h.fn('taskFor')();
    h.fn('setParam')('stream', true);
    const streaming = h.fn('taskFor')();
    h.fn('setParam')('stream', false);
    assert.equal(previous.parameters.stream, false);
    assert.equal(streaming.parameters.stream, true);
    assert.equal(h.fn('taskFor')().parameters.stream, false);
  }],
  ['An unfinished Director upload cannot overwrite another account or a page left by the user', async () => {
    for (const leave of ['account','page','new-file']) {
      const h=harness(); let finish, calls=0;
      h.scope.pageRef.current='director';
      Object.assign(h.scope, {importSequence:{current:0},readImage:()=>new Promise(resolve=>{finish=resolve;}),openDirector:()=>{calls++;}});
      const work=h.fn('uploadDirectorImage')({name:'test.png'});
      if (leave==='account') h.switchToB();
      if (leave==='page') h.scope.pageRef.current='draw';
      if (leave==='new-file') h.scope.importSequence.current++;
      finish({data:'YWJj',width:64,height:64,name:'test.png'});
      await work;
      assert.equal(calls,0);
      assert.deepEqual(h.state.errors,[]);
    }
  }],
  ['Director import and history reuse leave drawing prompts, references and masks untouched', async () => {
    const h = quoteHarness();
    h.fn('patchDraft')({prompt:'keep drawing',operation:'inpaint',parameters:{...h.state.draft.parameters,image:'draw-source',mask:'keep-mask'}});
    const original = structuredClone(h.state.draft);
    h.fn('acceptImage')('augment',{data:'YWJj',width:64,height:64,name:'source.png'});
    assert.equal(h.state.page,'director');
    assert.deepEqual({...h.state.draft,director:undefined},{...original,director:undefined});
    assert.equal(h.state.draft.director.source.data,'YWJj');
    const task = directorTask({...h.state.draft.director,tool:'emotion',prompt:'smile',emotion:'happy',defry:2});
    assert.equal(task.operation,'augment');
    assert.equal(task.parameters.mask,undefined);
    assert.deepEqual(task.parameters.reference_image_multiple,[]);
    assert.equal(task.parameters.width,64);
    await h.fn('reuse')({id:'director-result',job:task});
    assert.equal(h.state.draft.director.resultId,'director-result');
    assert.equal(h.state.draft.director.emotion,'happy');
    assert.deepEqual({...h.state.draft,director:undefined},{...original,director:undefined});
  }],
  ['Pending image reuse and file imports cannot reopen a page after navigation', async () => {
    for (const action of ['useAs','openImages','uploadImage']) {
      for (const leave of ['account','page','new-file']) {
        const h=harness(); let finish, calls=0;
        Object.assign(h.scope,{importSequence:{current:0},readImage:()=>new Promise(resolve=>{finish=resolve;}),acceptImage:()=>{calls++;},setImports:()=>{calls++;},setDragging:()=>{}});
        const row={id:'chosen-result',blob:new Blob(['fixture']),result:{filename:'fixture.png',media_type:'image/png'}};
        const work=action==='useAs'?h.fn(action)('augment',row):action==='uploadImage'?h.fn(action)('image',{}):h.fn(action)([{}]);
        if(leave==='account')h.switchToB();
        if(leave==='page')h.scope.pageRef.current='director';
        if(leave==='new-file')h.scope.importSequence.current++;
        finish({data:'YWJj',width:64,height:64,name:'fixture.png'});
        await work;
        assert.equal(calls,0,`${action}: ${leave}`);
        assert.deepEqual(h.state.errors,[]);
      }
    }
  }],
  ['Opening a saved image cancels after identity, page, selection or draft changes', async () => {
    for (const action of ['openResultCanvas','openResultPixelSnap']) {
      for (const change of ['account','page','selection','draft']) {
        const h=harness(); let finish,opened=0;
        h.state.selectedId='chosen-result';
        h.scope.readImage=()=>new Promise(resolve=>{finish=resolve;});
        h.scope.setCanvasInput=()=>{opened++;};
        h.scope.setPixelInput=()=>{opened++;};
        const row={id:'chosen-result',blob:new Blob(['fixture']),result:{filename:'fixture.png',media_type:'image/png'}};
        const work=h.fn(action)(row);
        if(change==='account')h.switchToB();
        if(change==='page')h.scope.pageRef.current='settings';
        if(change==='selection')h.scope.selectedIdRef.current='another-result';
        if(change==='draft')h.state.draft={...h.state.draft,prompt:'edited while image decoded'};
        finish({data:'YWJj',width:64,height:64,name:'fixture.png'});
        await work;
        assert.equal(opened,0,`${action}: ${change}`);
        assert.deepEqual(h.state.errors,[]);
      }
      const h=harness(); let opened=0;
      h.state.selectedId='chosen-result';
      h.scope.readImage=async()=>({data:'YWJj',width:64,height:64,name:'fixture.png'});
      h.scope.setCanvasInput=()=>{opened++;};
      h.scope.setPixelInput=()=>{opened++;};
      await h.fn(action)({id:'chosen-result',blob:new Blob(['fixture']),result:{filename:'fixture.png',media_type:'image/png'}});
      assert.equal(opened,1,`${action}: unchanged current selection still opens`);
    }
  }],
  ['Gallery reuse cannot overwrite a newer page, image selection or draft', async () => {
    for (const change of ['account','page','selection','new-import','draft']) {
      const h=harness(); let finish;
      h.state.draft=newDraft();
      h.state.selectedId='previous-selection';
      h.scope.defaultParameters=defaultParameters;
      h.scope.setPage=page=>{h.scope.pageRef.current=page;};
      h.scope.setMobileTab=()=>{};
      h.scope.setBlankCanvas=()=>{};
      h.scope.notify=()=>{};
      h.scope.readImage=()=>new Promise(resolve=>{finish=resolve;});
      const row={id:'old-result',blob:new Blob(['fixture']),result:{filename:'old.png',media_type:'image/png'},
        job:{operation:'generate',model:'nai-diffusion-4-5-full',prompt:'old prompt',negative_prompt:'',parameters:{seed:7}}};
      const work=h.fn('reuse')(row);
      if(change==='account')h.switchToB();
      if(change==='page')h.scope.pageRef.current='settings';
      if(change==='selection')h.scope.selectedIdRef.current='new-selection';
      if(change==='new-import')h.scope.importSequence.current++;
      if(change==='draft')h.state.draft={...h.state.draft,prompt:'new prompt'};
      finish({data:'YWJj',width:64,height:64,name:'old.png'});
      await work;
      assert.notEqual(h.state.draft.prompt,'old prompt',change);
      if(change==='draft')assert.equal(h.state.draft.prompt,'new prompt');
      assert.notEqual(h.state.selectedId,'old-result',change);
      assert.deepEqual(h.state.errors,[]);
    }
  }],
  ['Director completion cannot steal the drawing selection or replace a newer tool source', async () => {
    for (const change of ['none','source','model']) {
      const h = harness();
      const state = readDirectorDraft({tool:'lineart',source:{data:'YWJj',width:64,height:64,name:'test.png'}});
      Object.assign(h.job,directorTask(state));
      h.state.draft={...newDraft(),prompt:'keep drawing',director:{...state,model:change==='model'?'nai-diffusion-5-full':state.model,source:{...state.source,data:change==='source'?'ZGVm':'YWJj'}}};
      h.state.selectedId='drawing-selected';
      await h.fn('refresh')();
      assert.equal(h.state.selectedId,'drawing-selected');
      assert.equal(h.state.draft.director.resultId,change==='none'?h.result.id:undefined);
      assert.equal(h.state.draft.prompt,'keep drawing');
      assert.deepEqual(h.state.errors,[]);
    }
  }],
  ['A drawing completion while using another page keeps the previous drawing selection', async () => {
    const h=harness(); h.scope.pageRef.current='director'; h.state.selectedId='keep-selection';
    await h.fn('refresh')();
    assert.equal(h.state.selectedId,'keep-selection');
    assert.equal(h.state.rows.length,1);
    assert.deepEqual(h.state.errors,[]);
  }],
  ['Legacy director drafts migrate without losing the source or processing settings', async () => {
    const before={...newDraft(),operation:'augment',prompt:'old tool prompt',parameters:{...defaultParameters,image:'YWJj',width:128,height:64,req_type:'emotion',emotion:'happy',defry:3}};
    const after=migrateDirectorDraft(before);
    assert.equal(after.operation,'img2img');
    assert.deepEqual(after.parameters,before.parameters);
    assert.equal(after.director.source.data,'YWJj');
    assert.equal(after.director.prompt,'old tool prompt');
    assert.equal(after.director.emotion,'happy');
    assert.equal(after.director.defry,3);
    assert.equal(before.operation,'augment');
    assert.equal(readDirectorDraft({tool:'invalid',defry:99,emotion:{bad:true}}).tool,'lineart');
    assert.ok(directorSourceIssue({data:'YWJj',width:4096,height:4096,name:'oversized'}));
  }],
  ['Automatic draft restore drops uploaded pixels and reference caches while retaining settings', async () => {
    const restoreSession=actualFunction('restoreDraftForSession');
    assert.equal((sourceText.match(/\brestoreDraftForSession\(/g) ?? []).length,2,
      'the helper is declared once and called only by the automatic connection restore');
    assert.match(sourceText,/restoreDraftForSession\(migrateDirectorDraft\(stored \?\? newDraft\(\)\)\)/);
    const before={...newDraft(),operation:'inpaint',prompt:'keep prompt',futureDraftField:{keep:true},
      parameters:{...structuredClone(defaultParameters),width:1536,height:1024,steps:41,scale:6.25,seed:7731,noise:0.35,
        image:'source-image',mask:'source-mask',source_width:1536,source_height:1024,scale_factor:2,
        reference_image_multiple:['vibe-a','vibe-b'],reference_strength_multiple:[0.25,0.75],reference_information_extracted_multiple:[0.4,0.8],
        vibe_files:[{type:'image',data:'vibe-file'}],vibe_source_files:[{type:'encoding',data:'source-file'}],vibe_source_images:['source-vibe'],
        vibe_encodings:{'model|hash':'cached-encoding'},vibe_pending_indices:[1],
        character_reference_images:['character-image'],character_reference_descriptions:['character description'],
        character_reference_strengths:[0.6],character_reference_fidelities:[0.9],futureParameterField:{keep:true}},
      director:{model:'nai-diffusion-4-5-full',tool:'emotion',prompt:'keep director settings',emotion:'happy',defry:2,
        source:{data:'director-image',width:640,height:480,name:'director.png'},resultId:'old-result',futureDirectorField:'keep'}};
    const restored=restoreSession(before);
    assert.equal(restored.operation,'generate');
    assert.equal(restored.prompt,'keep prompt');
    assert.deepEqual(restored.futureDraftField,{keep:true});
    for(const [key,value] of Object.entries({width:1536,height:1024,steps:41,scale:6.25,seed:7731,noise:0.35,scale_factor:2}))
      assert.equal(restored.parameters[key],value,`${key} remains a user setting`);
    for(const key of ['image','mask','source_width','source_height','vibe_encodings','vibe_files','vibe_source_files','vibe_source_images','vibe_pending_indices'])
      assert.equal(Object.hasOwn(restored.parameters,key),false,`${key} is removed from session restore`);
    for(const key of ['reference_image_multiple','reference_strength_multiple','reference_information_extracted_multiple',
      'character_reference_images','character_reference_descriptions','character_reference_strengths','character_reference_fidelities'])
      assert.deepEqual(restored.parameters[key],[],`${key} is cleared with its aligned reference arrays`);
    assert.deepEqual(restored.parameters.futureParameterField,{keep:true});
    assert.equal(restored.director.source,undefined);
    assert.equal(restored.director.resultId,undefined);
    assert.equal(restored.director.prompt,'keep director settings');
    assert.equal(restored.director.futureDirectorField,'keep');
    assert.equal(before.parameters.image,'source-image','restoring does not mutate the stored input object');
    assert.equal(before.director.source.data,'director-image');

    const legacy={...newDraft(),operation:'augment',prompt:'legacy tool prompt',parameters:{...structuredClone(defaultParameters),
      image:'legacy-source',source_width:800,source_height:600,req_type:'emotion',emotion:'happy',defry:3}};
    const legacyRestored=restoreSession(migrateDirectorDraft(legacy));
    assert.equal(legacyRestored.operation,'generate','a migrated image operation falls back after its source is removed');
    assert.equal(legacyRestored.director.source,undefined);
    assert.equal(legacyRestored.director.prompt,'legacy tool prompt');
    assert.equal(legacyRestored.director.emotion,'happy');
    assert.equal(legacyRestored.director.defry,3);
  }],
  ['A newly saved result becomes selected without later polls stealing a manual selection', async () => {
    const h = harness();
    const refresh = h.fn('refresh');
    await refresh();
    assert.equal(h.state.selectedId, h.result.id);
    h.state.selectedId = 'manually-selected-history';
    await refresh();
    assert.equal(h.state.selectedId, 'manually-selected-history');
    assert.deepEqual(h.state.errors, []);
  }],
  ['Cancelling a replacement inpaint source preserves the original draft and mask', async () => {
    const original = {operation:'inpaint', count:3, model:'nai-diffusion-4-5-full', prompt:'keep prompt',
      parameters:{image:'old-image',mask:'old-mask',width:832,height:1216,reference_image_multiple:[],character_reference_images:[]}};
    let current = structuredClone(original), pending, shown=false;
    const scope = {usesGenerationSettings, draftRef:{current}, setDraft:value=>{current=typeof value==='function'?value(current):value;},
      setPendingMaskDraft:value=>{pending=value;},setShowMask:value=>{shown=value;},
      setPage:()=>{},setMobileTab:()=>{},notify:()=>{}};
    actualFunction('acceptImage',scope)('inpaint',{data:'replacement-image',width:1024,height:1024});
    assert.equal(shown,true);
    assert.equal(pending.parameters.image,'replacement-image');
    assert.deepEqual(current,original);
    actualFunction('closeMask',scope)();
    assert.equal(shown,false);
    assert.equal(pending,null);
    assert.deepEqual(current,original);
  }],
  ['Adding a Vibe reference preserves the current inpaint operation, source and mask', async () => {
    let current = {operation:'inpaint',model:'nai-diffusion-4-5-full',parameters:{image:'source',mask:'mask',
      character_reference_images:[],reference_image_multiple:[],reference_strength_multiple:[],reference_information_extracted_multiple:[]}};
    const scope = {usesGenerationSettings, draftRef:{current},setDraft:change=>{current=change(current);},setPage:()=>{},setMobileTab:()=>{},notify:()=>{}};
    actualFunction('acceptImage',scope)('vibe',{data:'reference'});
    assert.equal(current.operation,'inpaint');
    assert.equal(current.parameters.image,'source');
    assert.equal(current.parameters.mask,'mask');
    assert.deepEqual(current.parameters.reference_image_multiple,['reference']);
  }],
  ['Gallery reuse selects the same image whose parameters are restored', async () => {
    const h = harness();
    Object.assign(h.scope, {defaultParameters:{},setPage:()=>{},setMobileTab:()=>{}});
    h.state.draft = {parameters:{vibe_encodings:{}}};
    await h.fn('reuse')({id:'chosen-history',job:{operation:'generate',prompt:'chosen prompt',parameters:{seed:9}}});
    assert.equal(h.state.selectedId,'chosen-history');
    assert.equal(h.state.draft.prompt,'chosen prompt');
    assert.equal(h.state.draft.parameters.seed,9);
  }],
  ['Precise references survive model changes while V5 is blocked before quoting or submitting', async () => {
    const h = quoteHarness();
    h.fn('patchDraft')({prompt:'fixture prompt'});
    h.fn('acceptImage')('character', {data:'saved-reference',width:1024,height:1024});
    const original = structuredClone(h.state.draft.parameters);
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,1);
    h.fn('patchDraft')({model:'nai-diffusion-5-full'});
    const issue = configurationIssueFor(h.fn('taskFor')(),h.scope.caps.models,h.scope.caps.operations);
    assert.equal(issue.target,'references');
    assert.equal(issue.suggestedModel,'nai-diffusion-4-5-full');
    assert.throws(()=>h.fn('validateTask')(h.fn('taskFor')()),/精准参考仅支持 V4.5/);
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,1,'Invalid configuration must not reach the quote endpoint');
    assert.equal(h.state.quote,null);
    assert.equal(h.state.error,null,'An actionable configuration issue is not a retryable quote failure');
    assert.deepEqual(h.state.draft.parameters,original);
    h.fn('patchDraft')({model:'nai-diffusion-4-5-full'});
    assert.doesNotThrow(()=>h.fn('validateTask')(h.fn('taskFor')()));
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,2);
    assert.deepEqual(h.state.draft.parameters,original,'Switching back must restore usability without discarding references');
  }],
  ['Saved references do not block image tools; batch uses its effective generation operation', async () => {
    const h = quoteHarness();
    h.fn('patchDraft')({model:'nai-diffusion-5-full',operation:'upscale',parameters:{...structuredClone(defaultParameters),
      image:'source-image',character_reference_images:['saved-reference']}});
    for (const operation of ['upscale','augment']) {
      h.fn('patchDraft')({operation});
      assert.equal(configurationIssueFor(h.state.draft,h.scope.caps.models,h.scope.caps.operations),undefined);
      assert.doesNotThrow(()=>h.fn('validateTask')(h.fn('taskFor')()));
      await h.fn('requestQuote')(true);
      assert.deepEqual(h.state.requests.at(-1).task.parameters.character_reference_images,[]);
      assert.deepEqual(h.state.draft.parameters.character_reference_images,['saved-reference']);
    }
    h.state.page='batch';
    h.state.draft.batch.items[0].prompt='batch fixture';
    const batch = h.fn('batchTasks')();
    assert.equal(batch[0].operation,'generate');
    assert.equal(batch[0].parameters.image,undefined);
    assert.throws(()=>h.fn('validateTask')(batch[0]),/精准参考仅支持 V4.5/);
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,2,'Batch must not quote the unrelated image tool');
    h.fn('patchDraft')({model:'nai-diffusion-4-5-full'});
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.at(-1).task.operation,'generate');
    assert.equal(h.state.requests.at(-1).task.parameters.image,undefined);
  }],
  ['Quote failures distinguish invalid settings from retryable network failures', async () => {
    const h = quoteHarness();
    h.state.responseError=new ApiError('Controlled invalid settings',422);
    await h.fn('requestQuote')(true);
    assert.equal(h.state.quote,null);
    assert.deepEqual(h.state.error,{message:'Controlled invalid settings',retryable:false,connection:false});
    h.state.responseError=new ApiError('Controlled expired credential',401);
    await h.fn('requestQuote')(true);
    assert.deepEqual(h.state.error,{message:'Controlled expired credential',retryable:false,connection:true});
    h.state.responseError=new TypeError('Controlled network failure');
    await h.fn('requestQuote')(true);
    assert.deepEqual(h.state.error,{message:'Controlled network failure',retryable:true,connection:false});
    assert.equal(h.state.failure,null,'Quiet estimates must not create unrelated toast errors');
  }],
  ['An empty prompt can be quoted but cannot be submitted for generation', async () => {
    const h = quoteHarness();
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,1);
    assert.equal(h.state.quote.units,0);
    assert.equal(h.state.error,null);
    assert.throws(()=>h.fn('validateTask')(h.fn('taskFor')()),/先写一点提示词/);
  }],
  ['Legacy random drafts never override the visible prompt or batch prompts', async () => {
    const h = quoteHarness();
    h.fn('patchDraft')({prompt:'original scene', randomPrompt:'random scene'});
    assert.match(h.fn('taskFor')().prompt,/^original scene(?:,|$)/);
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.at(-1).task.prompt,h.fn('taskFor')().prompt);
    assert.equal(h.state.draft.prompt,'original scene');
    h.state.draft.batch.items[0].prompt='batch scene';
    assert.match(h.fn('batchTasks')()[0].prompt,/^batch scene(?:,|$)/);
    assert.equal(h.state.draft.randomPrompt,'random scene','Legacy text remains available in backups');
    h.fn('patchDraft')({prompt:''});
    assert.throws(()=>h.fn('validateTask')(h.fn('taskFor')()),/先写一点提示词/);
  }],
  ['V3 default UC yields to handwritten negative text', async () => {
    for (const model of ['nai-diffusion-3','nai-diffusion-furry-3']) {
      const draft={...newDraft(),model,ucPreset:'none'};
      assert.equal(composePrompts(draft,'scene',{artist:'',quality:'',negative:''}).negative,'lowres');
      assert.equal(composePrompts(draft,'scene',{artist:'',quality:'',negative:'bad hands'}).negative,'bad hands');
    }
  }],
  ['Changing model with an imported Vibe encoding blocks quote and queue without breaking render', async () => {
    const h = quoteHarness();
    const item = makeVibeFile('YWJj','nai-diffusion-4-5-full',.7,.6,true);
    h.fn('patchDraft')({prompt:'scene',parameters:{...h.state.draft.parameters,
      reference_image_multiple:['YWJj'],reference_strength_multiple:[.6],
      reference_information_extracted_multiple:[.7],vibe_files:[item]}});
    assert.doesNotThrow(()=>h.fn('taskFor')());
    h.fn('patchDraft')({model:'nai-diffusion-4-full'});
    const task=h.fn('taskFor')();
    assert.match(configurationIssueFor(task,h.scope.caps.models,h.scope.caps.operations).message,/Vibe 编码不适用于/);
    assert.throws(()=>h.fn('validateTask')(task),/Vibe 编码不适用于/);
    assert.doesNotThrow(()=>h.fn('batchTasks')());
    await h.fn('requestQuote')(true);
    assert.equal(h.state.requests.length,0);
  }],
  ['Removing a local image survives the next automatic poll', async () => {
    const h = harness();
    const refresh = h.fn('refresh');
    await refresh();
    assert.equal(h.state.rows.length, 1, 'Fixture must first be received by the real refresh function');
    await h.fn('removeLocal')(h.state.rows[0]);
    await refresh();
    assert.equal(h.state.records.size, 0, 'An intentionally removed local image must not be auto-imported again');
    assert.equal(h.state.rows.length, 0);
    assert.equal(h.state.downloads, 1);
    assert.equal(h.result.deleted, false, 'Removing the local copy must not implicitly delete the server copy');
    assert.deepEqual(h.state.errors, [], 'No unmodelled dependency may masquerade as successful deletion');
  }],
  ['A committed local image remains visible if the acknowledgement response is lost', async () => {
    const h = harness();
    const original = h.scope.api.request;
    h.scope.api.request = async route => {
      if (route.endsWith('/ack')) {
        h.result.acknowledged = true;
        h.result.deleted = true;
        throw new Error('Controlled loss of the acknowledgement response');
      }
      return original(route);
    };
    const refresh = h.fn('refresh');
    await refresh();
    assert.equal(h.state.saveIssue.saved, true);
    assert.match(h.state.saveIssue.message, /Controlled loss of the acknowledgement response/);
    await refresh();
    assert.equal(h.state.records.size, 1);
    assert.equal(h.state.rows.length, 1, 'A network acknowledgement failure must not hide a committed local image');
    assert.equal(h.result.deleted, true);
    assert.equal(h.state.saveIssue, null, 'A later confirmed acknowledgement clears only its own failure');
    assert.deepEqual(h.state.errors, []);
  }],
  ['Failed local save remains pending and recovery preserves unrelated errors', async () => {
    const h = harness(), store = h.scope.local.storeResult;
    h.state.errors.push(new Error('Unrelated import failure'));
    h.scope.local.storeResult = async () => { throw new DOMException('fixture quota', 'QuotaExceededError'); };
    const refresh = h.fn('refresh');
    await refresh();
    assert.equal(h.result.acknowledged, false);
    assert.equal(h.state.records.size, 0);
    assert.equal(h.state.saveIssue.saved, false);
    assert.match(h.state.saveIssue.message, /存储空间不足/);
    h.scope.local.storeResult = store;
    await refresh();
    assert.equal(h.result.acknowledged, true);
    assert.equal(h.state.jobs[0].results[0].acknowledged, true, 'UI receives the acknowledgement without another poll');
    assert.equal(h.state.records.size, 1);
    assert.equal(h.state.saveIssue, null);
    assert.equal(h.state.errors.length, 1);
    assert.equal(h.state.errors[0].message, 'Unrelated import failure');
  }],
  ['A late local save error cannot overwrite the new identity status', async () => {
    const h = harness();
    let rejectSave, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    h.scope.local.storeResult = async () => { markStarted(); return new Promise((_, reject) => { rejectSave = reject; }); };
    const work = h.fn('refresh')();
    await started;
    h.switchToB();
    rejectSave(new Error('Old identity write failed'));
    await work;
    assert.equal(h.state.saveIssue, null);
    assert.deepEqual(h.state.errors, []);
  }],
  ['An import started as A cannot overwrite the newly connected B draft', async () => {
    const h = harness();
    let finish;
    let markStarted;
    const pending = new Promise(resolve => { finish = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    h.scope.local.importBackup = async () => { markStarted(); return pending; };
    const importWork = h.fn('restore')([{name: 'fixture.json'}]);
    await started;
    h.switchToB();
    finish({count: 1, draft: {prompt: 'Private A backup draft'}});
    await importWork;
    assert.equal(h.state.draft.prompt, 'Owner B draft', 'A stale import must not change B state or trigger B autosave');
    assert.deepEqual(h.state.rows, []);
    assert.deepEqual(h.state.errors, [], 'A ReferenceError or missing harness dependency is not an identity guard');
  }],
  ['Explicit same-session backup import still restores uploaded images and references', async () => {
    const h=harness();
    h.scope.setBackupWarning=()=>{};
    const imported={...newDraft(),operation:'inpaint',parameters:{...structuredClone(defaultParameters),image:'backup-source',mask:'backup-mask',
      source_width:640,source_height:480,reference_image_multiple:['backup-vibe'],reference_strength_multiple:[0.5],
      reference_information_extracted_multiple:[0.7],vibe_files:[{type:'image',data:'backup-vibe-file'}],
      vibe_encodings:{'backup-key':'backup-encoding'},character_reference_images:['backup-character'],
      character_reference_descriptions:['backup description'],character_reference_strengths:[0.8],character_reference_fidelities:[0.9]},
      director:{model:'nai-diffusion-4-5-full',tool:'lineart',prompt:'backup director',emotion:'neutral',defry:0,
        source:{data:'backup-director-source',width:80,height:60,name:'backup.png'}}};
    h.scope.local.importBackup=async()=>({count:1,projects:0,draft:imported});
    await h.fn('restore')([{name:'fixture.json'}]);
    assert.equal(h.state.draft.parameters.image,'backup-source');
    assert.equal(h.state.draft.parameters.mask,'backup-mask');
    assert.deepEqual(h.state.draft.parameters.reference_image_multiple,['backup-vibe']);
    assert.deepEqual(h.state.draft.parameters.reference_strength_multiple,[0.5]);
    assert.deepEqual(h.state.draft.parameters.reference_information_extracted_multiple,[0.7]);
    assert.equal(h.state.draft.parameters.vibe_files[0].data,'backup-vibe-file');
    assert.equal(h.state.draft.parameters.vibe_encodings['backup-key'],'backup-encoding');
    assert.deepEqual(h.state.draft.parameters.character_reference_images,['backup-character']);
    assert.equal(h.state.draft.director.source.data,'backup-director-source');
  }],
];

for (const [name, boundary, argument] of [
  ['removeLocal', 'removeImage', {id: 'fixture-result'}],
  ['restore', 'importBackup', [{name: 'fixture.json'}]],
]) {
  checks.push([`${name} cannot act on a new identity after awaiting confirmation`, async () => {
    const h = harness();
    let accept;
    let boundaryCalls = 0;
    h.scope.askConfirmation = () => new Promise(resolve => { accept = resolve; });
    h.scope.local[boundary] = async () => { boundaryCalls++; throw new Error('Stale confirmation reached storage'); };
    const work = h.fn(name)(argument);
    h.switchToB();
    accept(true);
    await work;
    assert.equal(boundaryCalls, 0, 'An A confirmation must not perform storage work after switching to B');
    assert.deepEqual(h.state.errors, []);
    assert.equal(h.state.draft.prompt, 'Owner B draft');
  }]);
}

let failed = 0;
for (const [name, run] of checks) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n  ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} client lifecycle checks passed (actual functions, controlled boundaries).`);
if (failed) process.exitCode = 1;

// The same Variety+ setting is scaled only in the request snapshot. Model and
// sampler switches must produce the schedule actually sent to the service.
{
  const draft={...defaultParameters,width:1536,height:1024,sampler:'k_dpmpp_2m',noise_schedule:'native',skip_cfg_above_sigma:58};
  const sent=generationParameters('nai-diffusion-4-5-full',draft);
  assert.equal(sent.noise_schedule,'exponential');
  assert.ok(Math.abs(sent.skip_cfg_above_sigma - 58*Math.sqrt(192*128/(104*152))) < 1e-9);
  assert.equal(draft.skip_cfg_above_sigma,58);
  assert.equal(defaultNoiseSchedule('k_dpmpp_2m_sde'),'karras');
  console.log('PASS request parameters: sampler schedule and canvas-scaled Variety+');
}

// Verify the actual submit loop deduplicates shared paid encodings and persists before enqueue.
{
  let encoded=0,submitted=0,saved=0;
  class GateFixture {checkCapacity(){} async encodeVibe(){encoded++;return 'ZW5jb2RlZA==';}async request(){submitted++;assert.equal(saved,1);}}
  const api=new GateFixture(),owner={current:'owned-fixture'},generation={current:1};
  const draftRef={current:{parameters:{vibe_encodings:{}}}};
  const scope={api,GateApi:GateFixture,identity:owner,generation,draftRef,submitting:{current:false},setBusy:()=>{},
    validateTask:()=>{},defaultParameters:{},notify:()=>{},vibeKey:(s,m,e)=>`${s}|${m}|${e}`,uuid:()=>crypto.randomUUID(),
    setDraft:()=>{},local:{saveDraft:async()=>{saved++;}},submitCache:{current:null},setFailure:()=>{},setShowQueue:()=>{},refresh:()=>{},fail:e=>{throw e;}};
  const submit=actualFunction('submit',scope);
  const item=()=>({request_id:crypto.randomUUID(),model:'nai-diffusion-4-5-full',parameters:{seed:1,reference_image_multiple:['source'],reference_information_extracted_multiple:[1],vibe_pending_indices:[0]}});
  await submit([item(),item(),item()]);assert.equal(encoded,1);assert.equal(submitted,1);assert.equal(saved,1);
  // Logout during durable cache save must never submit a generation under the old credential.
  scope.draftRef.current={parameters:{vibe_encodings:{}}};
  scope.local.saveDraft=async()=>{generation.current++;};
  await submit([item()]);assert.equal(submitted,1);
  // disconnect resets the guard when it invalidates the old generation.
  scope.submitting.current=false;
  // A full queue must reject the entire batch before the paid Vibe encode call.
  generation.current=1;scope.draftRef.current={parameters:{vibe_encodings:{}}};
  scope.local.saveDraft=async()=>{saved++;};
  api.checkCapacity=()=>{throw new Error('队列已满');};
  await assert.rejects(submit([item()]),/队列已满/);
  assert.equal(encoded,2);assert.equal(submitted,1);
  console.log('PASS actual submit: shared Vibe encoded once, persisted before generation, logout blocks pending submission');
}
