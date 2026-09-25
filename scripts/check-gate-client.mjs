import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../client/package.json',import.meta.url));
const ts=require('typescript');
let seq=0, names=[], execute, executeSignals=[];
const saved={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,now:Date.now};
let now=1_000_000, timerSequence=0;
const timers=new Map();
let lastExecuteSignal;
Date.now=()=>now;
globalThis.setTimeout=(callback,delay)=>{const id=++timerSequence;timers.set(id,{at:now+Number(delay),callback});return id;};
globalThis.clearTimeout=id=>timers.delete(id);
const settle=()=>new Promise(resolve=>saved.setTimeout(resolve,0));
async function advance(milliseconds) {
  const target=now+milliseconds;
  while(true) {
    const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next)break;
    now=next[1].at;timers.delete(next[0]);next[1].callback();await settle();
  }
  now=target;await settle();
}
const events=(...items)=>new Response(items.map(item=>JSON.stringify(item)+'\n').join(''));
const final=()=>({type:'final',artifacts:[{data:'dGVzdA==',media_type:'image/png',filename:'test.png',metadata:{},sha256:'hash'}]});
const limited=(code='gate_rpm',retry_after=2)=>({type:'error',code,retryable:true,retry_after,uncertain:false,message:'请等待后继续'});
globalThis.fetch=async(url,options)=>{
  if(url.endsWith('/execute')) {
    const task=JSON.parse(options.body);names.push(task.label);lastExecuteSignal=options.signal;executeSignals.push(options.signal);return execute(task);
  }
  return Response.json({id:'test'});
};
function compiled(file,deps={}) {
  const source=fs.readFileSync(new URL('../client/src/'+file,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};new Function('require','exports',code)(name=>deps[name],exports);return exports;
}
const api=compiled('api.ts');
const {GateApi}=compiled('gateApi.ts',{'./api':api,'./types':{uuid:()=>`result-${++seq}`}});
const {default:GateQueueStatus,gateJobLabel,queueWaitLabel}=compiled('GateQueueStatus.tsx',{'react':require('react'),'react/jsx-runtime':require('react/jsx-runtime')});
const {renderToStaticMarkup}=require('react-dom/server');
  const task=label=>({request_id:label,label,parameters:{},prompt:'',negative_prompt:'',model:'test',operation:'generate'});
const batch=(...labels)=>({request_id:labels.join('-'),items:labels.map(task)});
const state=client=>client.request('/jobs');
  const jobs=async client=>(await state(client)).jobs;
async function ack(client,index=0) {
  const result=(await jobs(client))[index].results[0];
  await client.request(`/results/${result.id}/ack`,{sha256:'hash'});await settle();
}
function reset(handler=()=>events(final())) {
  assert.equal(timers.size,0,'previous client must not leave retry timers alive');
  names=[];executeSignals=[];execute=handler;
}
try {
  {
    const api={},counts={active:0,waiting:0,concurrency:1};
    const display=(remaining,serverOffset=0,age=0)=>renderToStaticMarkup(require('react').createElement(GateQueueStatus,{monitor:{
      api,snapshot:{global:counts,image_cooldown_remaining:remaining,sampled_at:now/1000+serverOffset},
      receivedAt:performance.now()-age*1000,
    }}));
    for(const offset of [-3600,0,1,3600]) {
      assert.doesNotMatch(display(0,offset),/冷却|不可用/,'clock skew cannot invent a cooldown or stale state');
      assert.match(display(3,offset),/冷却约 3 秒/,'a real cooldown does not depend on either wall clock');
    }
    assert.match(display(3,1,1.1),/冷却约 2 秒/);
    assert.match(display(3,1,2.1),/冷却约 1 秒/,'keep the final real second visible');
    assert.doesNotMatch(display(3,1,3.1),/冷却/);
    assert.match(display(0,0,15.1),/服务器状态暂不可用/,'unchanged snapshots age out on the local clock');
    assert.match(display(0),/全站：占用 0\/1 · 排队 0/);
    console.log('PASS queue display: clock skew, real countdown, local expiry and compact copy');
  }
  // Accepted-but-held replies must not claim generation has started. A preview is evidence.
  let accept, stream;
  reset(()=>new Promise(resolve=>{accept=resolve;}));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('held','later'));await settle();
    assert.equal(gateJobLabel((await jobs(client))[0]),'正在提交');
    accept(new Response(new ReadableStream({start(controller){stream=controller;}})));await settle();
    let current=await jobs(client);
    assert.equal(gateJobLabel(current[0]),'等待服务器结果');assert.equal(gateJobLabel(current[1]),'本机待发送');
    assert.equal((await state(client)).queue_paused,false);assert.deepEqual(names,['held']);
    stream.enqueue(new TextEncoder().encode(JSON.stringify({type:'preview',preview:{image:'fixture',media_type:'image/png'}})+'\n'));await settle();
    assert.equal(gateJobLabel((await jobs(client))[0]),'生成中');
    stream.enqueue(new TextEncoder().encode(JSON.stringify(final())+'\n'));stream.close();await settle();
    current=await jobs(client);assert.equal(current[0].status,'succeeded');assert.equal(current[0].execution_phase,undefined);
    assert.deepEqual(names,['held'],'observability does not bypass the save acknowledgement');client.close();
  }
  reset();
  {
    const running={...task('heartbeat'),id:'heartbeat',status:'running',started_at:now/1000,last_data_at:now/1000,execution_phase:'waiting_result'};
    assert.equal(gateJobLabel(running,now/1000),'等待服务器结果');
    assert.equal(gateJobLabel(running,now/1000+59.999),'等待服务器结果');
    assert.equal(gateJobLabel(running,now/1000+60),'暂未收到新数据，仍在等待结果');
    running.last_data_at=now/1000+60;
    assert.equal(gateJobLabel(running,running.last_data_at),'等待服务器结果','new received data returns the label to the normal waiting state');
  }
  {
    const client=new GateApi('','A'),original=batch('a','b');
    await client.request('/batches',original);await settle();
    await client.request('/batches',original);await settle();
    assert.deepEqual(names,['a'],'local commit and duplicate batch must both block another request');
    const current=await jobs(client);assert.equal(current[0].status,'succeeded');assert.equal(current[1].status,'queued');
    const result=current[0].results[0];assert.equal(await(await client.content(result.id)).text(),'test');
    await assert.rejects(()=>client.request(`/results/${result.id}/ack`,{sha256:'wrong'}));
    assert.deepEqual(names,['a']);await ack(client);assert.deepEqual(names,['a','b']);
    await assert.rejects(()=>client.content(result.id));
    const another=new GateApi('','B');assert.equal((await jobs(another)).length,0);
    await assert.rejects(()=>another.content(result.id));client.close();another.close();
  }
  for(const fixture of [
    {label:'unknown error',response:()=>events({type:'error',message:'fixture failure',uncertain:true}),status:'unknown'},
    {label:'missing final',response:()=>events({type:'preview',preview:{image:'test',media_type:'image/png'}}),status:'unknown'},
    {label:'retry signal after preview',response:()=>events({type:'preview',preview:{image:'test',media_type:'image/png'}},limited()),status:'unknown'},
    {label:'malformed final',response:()=>events({type:'final',artifacts:[]},limited()),status:'unknown'},
    {label:'partially damaged final',response:()=>events({type:'final',artifacts:[final().artifacts[0],{...final().artifacts[0],data:'@@'}]},limited()),status:'unknown',resultCount:0},
    {label:'quota failure',response:()=>events({type:'error',code:'gate_quota',retryable:false,message:'额度不足',uncertain:false}),status:'failed'},
    {label:'unknown retry code',response:()=>events({...limited(),code:'upstream_ratelimit'}),status:'failed'},
    {label:'missing rejection certainty',response:()=>events({...limited(),uncertain:undefined}),status:'unknown'},
    {label:'plain HTTP 429',response:()=>Response.json({detail:'Too many requests'},{status:429}),status:'failed'},
    {label:'unconfirmed HTTP 500',response:()=>Response.json({detail:'Internal error'},{status:500}),status:'unknown'},
    {label:'network interruption',response:()=>{throw new Error('connection interrupted');},status:'unknown'},
  ]) {
    reset(fixture.response);
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    let snapshot=await state(client);
    assert.equal(snapshot.jobs[0].status,fixture.status,fixture.label);
    if(fixture.resultCount!==undefined)assert.equal(snapshot.jobs[0].results.length,fixture.resultCount,fixture.label);
    assert.equal(snapshot.jobs[1].status,'queued',fixture.label);
    if(fixture.label==='network interruption')assert.match(snapshot.jobs[0].error,/Gate 连接中断/);
    assert.equal(snapshot.queue_paused,true,fixture.label);assert.equal(client.pending(),true);
    assert.equal(timers.size,0);await advance(120_000);assert.deepEqual(names,['first']);
    execute=()=>events(final());
    await client.request('/batches',batch('third'));await settle();assert.deepEqual(names,['first'],'new work cannot bypass an error pause');
    await client.request('/queue/resume',{});await settle();assert.deepEqual(names,['first','second'],'resume must not repeat uncertain/failed work');
    await ack(client,1);assert.deepEqual(names,['first','second','third']);client.close();
  }
  console.log('PASS ordered queue, local-save gating, deduplication and error pause without discarding unsent work');
  reset(()=>events(final(),limited()));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    const snapshot=await state(client);assert.equal(snapshot.jobs[0].status,'succeeded');assert.equal(snapshot.jobs[0].results.length,1);
    assert.equal(snapshot.queue_paused,false);assert.equal(timers.size,0);
    // A complete final is terminal: later frames cannot retract a result already accepted locally.
    await ack(client);assert.deepEqual(names,['first','second'],'a later frame after final must not pause the ordered queue');client.close();
  }
  console.log('PASS a valid terminal final ends the stream and later frames cannot overturn it');

  let openGeneration, generationCancelled=false;
  reset(()=>names.length===1?new Response(new ReadableStream({start(controller){openGeneration=controller;},cancel(){generationCancelled=true;return new Promise(()=>{});}})):events(final()));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    openGeneration.enqueue(new TextEncoder().encode(JSON.stringify(final())+'\n'));await settle();
    let current=await jobs(client);assert.equal(current[0].status,'succeeded');assert.equal((await state(client)).queue_paused,false);
    assert.equal(generationCancelled,true,'final must cancel the open reader without awaiting its unresolved cancel promise');
    assert.deepEqual(names,['first']);await ack(client);assert.deepEqual(names,['first','second'],'the next image still waits for local acknowledgement');
    assert.notEqual(executeSignals[0],executeSignals[1],'each execution gets an independent abort signal');
    assert.equal(executeSignals[0].aborted,true,'the completed request is cancelled before the next item is sent');
    client.close();
  }
  console.log('PASS open generation stream terminates at final, cancels promptly and retains acknowledgement ordering');

  for(const [code,reason,expected] of [['gate_rpm',undefined,'rpm'],['gate_cooldown',undefined,'cooldown'],['gate_busy',undefined,'service_busy'],['gate_busy','key_busy','key_busy']]) {
    reset(()=>names.length===1?events({...limited(code),reason}):events(final()));
    const client=new GateApi('','A'),original=batch('first','second');
    await client.request('/batches',original);await settle();
    let snapshot=await state(client);
    assert.equal(snapshot.jobs[0].status,'waiting');assert.equal(snapshot.jobs[0].retry_at,(now+2000)/1000);
    assert.equal(snapshot.jobs[0].retry_reason,expected);assert.equal(gateJobLabel(snapshot.jobs[0]),queueWaitLabel(expected));
    assert.equal(snapshot.jobs[0].retry_count,1);assert.equal(snapshot.jobs[0].completed_at,undefined);
    assert.equal(snapshot.jobs[1].status,'queued');assert.equal(snapshot.queue_paused,false);assert.equal(client.pending(),true);
    await client.request('/batches',original);await client.request('/queue/resume',{});await settle();
    assert.equal(timers.size,1);assert.deepEqual(names,['first'],'resume and duplicate submission cannot bypass cooldown');
    await advance(1999);assert.deepEqual(names,['first']);await advance(1);assert.deepEqual(names,['first','first']);
    snapshot=await state(client);assert.equal(snapshot.jobs[0].status,'succeeded');assert.equal(snapshot.jobs[0].results.length,1);
    assert.equal(snapshot.jobs[0].retry_at,undefined);assert.equal(snapshot.jobs[0].error,undefined);
    assert.equal(snapshot.jobs[0].retry_reason,undefined);
    assert.equal(snapshot.jobs[1].status,'queued');assert.equal(timers.size,0);
    await ack(client);assert.deepEqual(names,['first','first','second']);client.close();
  }
  reset(()=>names.length===1?Response.json({detail:limited()},{status:429}):events(final()));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first'));await settle();
    assert.equal((await jobs(client))[0].status,'waiting');await advance(2000);assert.equal((await jobs(client))[0].status,'succeeded');client.close();
  }
  reset(()=>events(limited()));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    await advance(2000);let first=(await jobs(client))[0];assert.equal(first.retry_count,2);assert.equal(first.retry_at,(now+4000)/1000);
    await advance(3999);assert.deepEqual(names,['first','first']);await advance(1);
    first=(await jobs(client))[0];assert.equal(first.retry_count,3);assert.equal(first.retry_at,(now+8000)/1000);
    execute=()=>events(final());await client.request('/jobs/first/cancel',{});await settle();
    assert.deepEqual(names,['first','first','first','second']);assert.equal((await jobs(client))[0].status,'cancelled');
    assert.equal(timers.size,0);await advance(10_000);assert.equal(names.length,4);client.close();
  }
  console.log('PASS controlled RPM/cooldown/busy recovery, original-task retry, FIFO, backoff and cancellation');

  reset(()=>names.length===1?events(limited()):events(final()));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    await client.request('/queue/pause',{});assert.equal(timers.size,0);assert.equal((await state(client)).queue_paused,true);
    await advance(5000);assert.deepEqual(names,['first']);await client.request('/queue/resume',{});await settle();
    assert.deepEqual(names,['first','first']);assert.equal((await jobs(client))[0].status,'succeeded');client.close();
  }
  reset();
  {
    const client=new GateApi('','A');await client.request('/queue/pause',{});
    await client.request('/batches',batch('first','second'));await settle();assert.equal(names.length,0);
    await client.request('/jobs/first/cancel',{});await settle();assert.equal(names.length,0);
    await client.request('/queue/resume',{});await settle();assert.deepEqual(names,['second']);client.close();
  }
  for(const [delay,expected] of [[0,1],[999999,3600],[undefined,60],[null,60]]) {
    reset(()=>events({...limited(),retry_after:delay}));
    const client=new GateApi('','A');await client.request('/batches',batch('first'));await settle();
    assert.equal((await jobs(client))[0].retry_at,(now+expected*1000)/1000);
    assert.equal(timers.size,1);client.close();assert.equal(timers.size,0);await advance(expected*1000+1);assert.equal(names.length,1);
    await assert.rejects(()=>client.request('/queue/resume',{}),/关闭/);
  }
  console.log('PASS pause/resume, bounded waits and close timer cleanup');

  reset(()=>events({type:'final',artifacts:[{media_type:'application/json',data:btoa(JSON.stringify({encoding:'ZW5jb2RlZA=='}))}]}));
  {
    const client=new GateApi('','owned-fixture');
    assert.equal(await client.encodeVibe({...task('encode'),operation:'encode_vibe'}),'ZW5jb2RlZA==');
    assert.equal((await jobs(client)).length,0);assert.equal(client.pending(),false);
    execute=()=>events({type:'preview'});await assert.rejects(()=>client.encodeVibe(task('broken')),/未确认/);
    assert.equal(names.length,2,'encoding failure must not retry');assert.equal(client.pending(),false);
    client.close();await assert.rejects(()=>client.encodeVibe(task('closed')),/关闭/);assert.equal(names.length,2);
  }
  console.log('PASS Vibe encoding extraction, no gallery artifact and uncertain-result handling');
  let openEncoding, encodingCancelled=false;
  reset(()=>new Response(new ReadableStream({start(controller){openEncoding=controller;},cancel(){encodingCancelled=true;return new Promise(()=>{});}})));
  {
    const client=new GateApi('','owned-fixture'),pending=client.encodeVibe({...task('encode-open'),operation:'encode_vibe'});await settle();
    openEncoding.enqueue(new TextEncoder().encode(JSON.stringify({type:'final',artifacts:[{media_type:'application/json',data:btoa(JSON.stringify({encoding:'ZW5jb2RlZA=='}))}]})+'\n'));
    assert.equal(await pending,'ZW5jb2RlZA==');assert.equal(encodingCancelled,true,'Vibe final must cancel an open reader without awaiting cancellation');
    client.close();
  }
  console.log('PASS Vibe final returns while the response stream remains open');
  const encoded=()=>events({type:'final',artifacts:[{media_type:'application/json',data:btoa(JSON.stringify({encoding:'ZW5jb2RlZA=='}))}]});
  reset(()=>names.length===1?events(limited()):encoded());
  {
    const client=new GateApi('','A'),pending=client.encodeVibe({...task('encode'),operation:'encode_vibe'});
    await settle();const snapshot=await state(client);
    assert.equal(snapshot.encoding,true);assert.equal(snapshot.encoding_retry_at,(now+2000)/1000);assert.equal(client.pending(),true);
    await assert.rejects(()=>client.encodeVibe(task('other')),/等待/);
    await advance(1999);assert.deepEqual(names,['encode']);await advance(1);assert.equal(await pending,'ZW5jb2RlZA==');
    assert.deepEqual(names,['encode','encode']);assert.equal((await state(client)).encoding_retry_at,undefined);
    assert.equal(client.pending(),false);assert.equal(timers.size,0);client.close();
  }
  reset(()=>events({type:'preview'},limited()));
  {
    const client=new GateApi('','A');await assert.rejects(()=>client.encodeVibe(task('encode')));
    assert.equal(names.length,1);assert.equal(timers.size,0);client.close();
  }
  reset(()=>names.length===1?events(limited()):encoded());
  {
    const client=new GateApi('','A'),pending=client.encodeVibe(task('encode'));await settle();
    const retryAt=(await state(client)).encoding_retry_at;
    await client.request('/queue/pause',{});assert.equal(timers.size,0);assert.equal((await state(client)).encoding_paused,true);
    await advance(1000);await client.request('/queue/resume',{});assert.equal(timers.size,1);
    assert.equal((await state(client)).encoding_retry_at,retryAt,'resume must preserve the original cooldown');
    await advance(999);assert.deepEqual(names,['encode']);
    await client.request('/queue/pause',{});await advance(3000);
    assert.deepEqual(names,['encode'],'paused encoding must not send after its cooldown expires');
    assert.equal((await state(client)).encoding_paused,true);assert.equal(timers.size,0);
    await client.request('/queue/resume',{});assert.equal(await pending,'ZW5jb2RlZA==');assert.deepEqual(names,['encode','encode']);client.close();
  }
  reset(encoded);
  {
    const client=new GateApi('','A');await client.request('/queue/pause',{});
    const pending=client.encodeVibe(task('encode')),rejection=assert.rejects(()=>pending,/关闭/);await settle();
    assert.equal(names.length,0,'an already paused queue must also hold the first encoding request');
    assert.equal((await state(client)).encoding_paused,true);assert.equal(timers.size,0);
    client.close();await rejection;assert.equal(timers.size,0);
  }
  reset(()=>events(limited()));
  {
    const client=new GateApi('','A'),pending=client.encodeVibe(task('encode'));
    const rejection=assert.rejects(()=>pending,/关闭/);await settle();assert.equal(timers.size,1);
    client.close();await rejection;assert.equal(timers.size,0);await advance(60_000);assert.equal(names.length,1);
  }
  console.log('PASS Vibe encoding cooldown recovery, pause/resume and cancellable wait cleanup');

  let heldStream;
  reset(()=>new Response(new ReadableStream({start(controller){heldStream=controller;}})));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('first','second'));await settle();
    assert.equal(timers.size,1,'a pending stream read has a 360-second idle deadline');
    await advance(359_999);heldStream.enqueue(new TextEncoder().encode(' '));await settle();
    assert.equal((await jobs(client))[0].last_data_at,now/1000,'any received bytes refresh the local progress timestamp');
    assert.equal(timers.size,1);await advance(359_999);assert.equal((await jobs(client))[0].status,'running');
    heldStream.enqueue(new TextEncoder().encode('\n'));await settle();
    await advance(360_000);
    let snapshot=await state(client);assert.equal(snapshot.jobs[0].status,'unknown');assert.match(snapshot.jobs[0].error,/360 秒/);
    assert.equal(snapshot.jobs[1].status,'queued');assert.equal(snapshot.queue_paused,true);assert.equal(timers.size,0);
    assert.equal(names.length,1,'idle timeout must not automatically replay an uncertain request');assert.equal(lastExecuteSignal.aborted,true);
    execute=()=>events(final());await client.request('/queue/resume',{});await settle();
    assert.deepEqual(names,['first','second'],'manual recovery runs only the queued next item');client.close();
  }
  console.log('PASS stream timeout resets on bytes, pauses without replay, and manual resume sends only the next item');

  let emptyChunkStream;
  reset(()=>new Response(new ReadableStream({start(controller){emptyChunkStream=controller;}})));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('empty-chunk'));await settle();
    await advance(359_999);emptyChunkStream.enqueue(new Uint8Array(0));await settle();
    await advance(1);const snapshot=await state(client);
    assert.equal(snapshot.jobs[0].status,'unknown','empty chunks do not count as progress or reset the idle deadline');
    assert.equal(snapshot.queue_paused,true);assert.equal(names.length,1);client.close();
  }
  console.log('PASS empty stream chunks do not extend the no-data deadline');

  reset(()=>new Promise(()=>{}));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('fetch-hang','later'));await settle();
    assert.equal(timers.size,1,'waiting for fetch response headers also has a 360-second deadline');
    await advance(360_000);const snapshot=await state(client);
    assert.equal(snapshot.jobs[0].status,'unknown');assert.match(snapshot.jobs[0].error,/360 秒/);
    assert.equal(snapshot.jobs[1].status,'queued');assert.equal(snapshot.queue_paused,true);assert.equal(lastExecuteSignal.aborted,true);
    assert.equal(names.length,1);client.close();assert.equal(timers.size,0);
  }
  console.log('PASS fetch response timeout pauses the queue and aborts its isolated request signal');

  reset(()=>new Promise(()=>{}));
  {
    const client=new GateApi('','A');await client.request('/batches',batch('close-hang'));await settle();
    assert.equal(timers.size,1);client.close();await settle();
    assert.equal(timers.size,0,'close abort must clear the active execution timer');
    assert.equal(lastExecuteSignal.aborted,true);
  }
  console.log('PASS close aborts an active execution and clears its timer');
} finally {
  globalThis.fetch=saved.fetch;globalThis.setTimeout=saved.setTimeout;globalThis.clearTimeout=saved.clearTimeout;Date.now=saved.now;
}
