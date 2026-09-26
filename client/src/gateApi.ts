import { Api } from './api';
import { uuid } from './types';
import type { Job, Task, Result, User, QueueWaitReason } from './types';

type PreviewJob = Job & { preview?: { image: string; media_type: string; step?: number } };
type ExecutionFailure = { code?: string; reason?: string; retryable?: boolean; retry_after?: number; uncertain?: boolean };
const EXECUTION_TIMEOUT_MS = 360_000;
const FETCH_TIMEOUT_MESSAGE = 'Gate 请求等待超过 360 秒，结果未确认；请核对用量后再手动恢复';
const STREAM_TIMEOUT_MESSAGE = 'Gate 结果流 360 秒未收到新数据，结果未确认；请核对用量后再手动恢复';
const CONNECTION_INTERRUPTED_MESSAGE = 'Gate 连接中断，完整结果未确认；请核对用量后再手动恢复';
type LinkedExecution = {
  signal: AbortSignal;
  wait<T>(operation: () => Promise<T>, timeoutMessage: string, timeoutMs?: number): Promise<T>;
  dispose(): void;
};
function linkedExecution(closeSignal: AbortSignal): LinkedExecution {
  const controller = new AbortController();
  let timedOut = false;
  const close = () => controller.abort();
  if (closeSignal.aborted) controller.abort();
  else closeSignal.addEventListener('abort', close, {once:true});
  return {
    signal:controller.signal,
    wait<T>(operation:()=>Promise<T>, timeoutMessage:string, timeoutMs=EXECUTION_TIMEOUT_MS) {
      return new Promise<T>((resolve,reject) => {
        let timer:ReturnType<typeof setTimeout>|undefined;
        let settled=false;
        const finish=(complete:()=>void) => {
          if(settled)return;
          settled=true;
          if(timer!==undefined)clearTimeout(timer);
          controller.signal.removeEventListener('abort',aborted);
          complete();
        };
        const aborted=()=>finish(()=>reject(new Error(timedOut?timeoutMessage:'连接已关闭')));
        if(controller.signal.aborted){aborted();return;}
        timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
        controller.signal.addEventListener('abort',aborted,{once:true});
        Promise.resolve().then(operation).then(
          value=>finish(()=>resolve(value)),
          ()=>finish(()=>reject(new Error(CONNECTION_INTERRUPTED_MESSAGE))),
        );
      });
    },
    dispose() {
      closeSignal.removeEventListener('abort',close);
      if(!controller.signal.aborted)controller.abort();
    },
  };
}
function parseEvent(line:string) {
  try {
    const event=JSON.parse(line);
    if(!event || typeof event!=='object' || Array.isArray(event))throw new Error('invalid event');
    return event;
  }
  catch { throw new Error('Gate 返回的数据格式无效，完整结果未确认；请核对用量后再手动恢复'); }
}
function cancelReader(reader:ReadableStreamDefaultReader<Uint8Array>) {
  try { void reader.cancel().catch(()=>{}); }
  catch { /* Reader cancellation must never hold queue progress. */ }
}
function waitReason(failure: ExecutionFailure): QueueWaitReason {
  return failure.code === 'gate_rpm' ? 'rpm' : failure.code === 'gate_cooldown' ? 'cooldown' :
    failure.reason === 'key_busy' ? 'key_busy' : 'service_busy';
}
class GateExecutionError extends Error {
  constructor(message: string, public failure: ExecutionFailure = {}) { super(message); }
}
function mayRetry(failure: ExecutionFailure | undefined, receivedOutput: boolean) {
  return !receivedOutput && failure?.retryable === true && failure.uncertain === false &&
    ['gate_rpm','gate_cooldown','gate_busy'].includes(failure.code ?? '');
}
function retryDelay(failure: ExecutionFailure, retryCount: number) {
  const supplied = failure.retry_after;
  const delay = typeof supplied === 'number' && Number.isFinite(supplied) ? Math.min(3600, Math.max(1, supplied)) : 60;
  // Repeated rejections back off; a longer explicit cooldown always takes precedence.
  return Math.max(delay, Math.min(300, delay * 2 ** Math.min(9, retryCount - 1)));
}
export const MAX_PENDING = 50;
export class GateApi extends Api {
  private jobs: PreviewJob[] = [];
  private blobs = new Map<string, Blob>();
  private batches = new Set<string>();
  private working = false;
  private closed = false;
  private controller = new AbortController();
  private me?: User;
  private meAt = 0;
  private encoding = false;
  private encodingRetryAt?: number;
  private encodingWaitReason?: QueueWaitReason;
  private encodingWait?: { resume: () => void; pause: () => void };
  private queuePaused = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  checkCapacity(count: number) {
    const remaining = MAX_PENDING - this.jobs.filter(j => ["queued", "waiting", "running"].includes(j.status)).length;
    if (!Number.isInteger(count) || count < 1 || count > remaining)
      throw new Error(`本次 ${count} 张，队列还可加入 ${remaining} 张，请减少数量或等待队列完成。`);
  }
  pending() { return this.encoding || this.jobs.some(j => ['queued','waiting','running'].includes(j.status) || j.results.some(r => !r.acknowledged && !r.deleted)); }
  async encodeVibe(task: Task): Promise<string> {
    if(this.closed)throw new Error('连接已关闭');
    if(this.pending()) throw new Error('请等待当前队列保存完成，再编码新的 Vibe 参考');
    this.encoding=true;
    let retries=0;
    let retryAt:number|undefined;
    try { while(true) {
      let receivedOutput=false;
      const execution=linkedExecution(this.controller.signal);
      try {
        await this.waitForEncodingReady(retryAt);
        if(this.closed)throw new Error('连接已关闭');
        if(this.queuePaused)continue;
        this.encodingWaitReason=undefined;
        const response=await execution.wait(()=>this.raw('/execute',task,execution.signal),FETCH_TIMEOUT_MESSAGE);
        if(!response.ok) {
          const error=await execution.wait(()=>response.json().catch(()=>({detail:`编码请求失败 (${response.status})`})),STREAM_TIMEOUT_MESSAGE);
          const detail=typeof error.detail==='object' && error.detail!==null?error.detail:error;
          throw new GateExecutionError(typeof detail.message==='string'?detail.message:typeof error.detail==='string'?error.detail:'Vibe 编码失败',
            {...detail,uncertain:detail.uncertain??response.status>=500});
        }
        if(!response.body)throw new Error('编码结果未确认，请核对用量后再试');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',encoding:string|undefined;
        let terminal=false,readDeadline=Date.now()+EXECUTION_TIMEOUT_MS;
        const processLine=(line:string) => {
          if(!line.trim())return;
          const event=parseEvent(line);
          if(event.type==='preview')receivedOutput=true;
          if(event.type==='error')throw new GateExecutionError(event.message,event);
          if(event.type==='final') {
            terminal=true;receivedOutput=true;
            const artifact=Array.isArray(event.artifacts)?event.artifacts[0]:undefined;
            if(artifact?.media_type!=='application/json' || typeof artifact.data!=='string' || !artifact.data)throw new Error('Vibe 编码结果格式无效，完整结果未确认');
            let value;
            try { value=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(artifact.data),c=>c.charCodeAt(0)))); }
            catch { throw new Error('Vibe 编码结果数据损坏，完整结果未确认'); }
            if(!value || typeof value!=='object' || typeof value.encoding!=='string' || !value.encoding || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encoding))throw new Error('未收到有效 Vibe 编码');
            encoding=value.encoding;
          }
        };
        try { while(true) {
          const {done,value}=await execution.wait(()=>reader.read(),STREAM_TIMEOUT_MESSAGE,Math.max(1,readDeadline-Date.now()));
          if(value?.byteLength)readDeadline=Date.now()+EXECUTION_TIMEOUT_MS;
          buffer+=decoder.decode(value,{stream:!done});
          if(buffer.length>32*1024*1024)throw new Error('Vibe 编码结果过大');
          let next;
          while(!terminal && (next=buffer.indexOf('\n'))>=0) {
            const line=buffer.slice(0,next);buffer=buffer.slice(next+1);processLine(line);
          }
          if(done && !terminal && buffer.trim())processLine(buffer);
          if(done || terminal)break;
        } } finally {cancelReader(reader);}
        if(!encoding)throw new Error('编码结果未确认，请核对用量后再试；没有自动重试');
        return encoding;
      } catch(error) {
        const failure=error instanceof GateExecutionError?error.failure:undefined;
        if(this.closed || !mayRetry(failure,receivedOutput))throw error;
        this.encodingWaitReason=waitReason(failure!);
        retryAt=Date.now()/1000+retryDelay(failure!,++retries);
      } finally { execution.dispose(); }
    } } finally {this.encoding=false;this.encodingRetryAt=undefined;this.encodingWaitReason=undefined;this.meAt=0;void this.pump();}
  }
  private async waitForEncodingReady(retryAt?: number) {
    const signal=this.controller.signal;
    if(signal.aborted)throw new Error('连接已关闭');
    this.encodingRetryAt=retryAt;
    try { await new Promise<void>((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const clear=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;};
      const cleanup=()=>{clear();signal.removeEventListener('abort',abort);this.encodingWait=undefined;};
      const abort=()=>{cleanup();reject(new Error('连接已关闭'));};
      const ready=()=>{
        clear();
        if(signal.aborted){abort();return;}
        if(this.queuePaused)return;
        const wait=(retryAt??0)-Date.now()/1000;
        if(wait>0)timer=setTimeout(ready,Math.max(1,Math.ceil(wait*1000)));
        else {cleanup();resolve();}
      };
      this.encodingWait={resume:ready,pause:clear};
      signal.addEventListener('abort',abort,{once:true});
      ready();
    }); } finally {this.encodingRetryAt=undefined;}
  }
  close() {
    this.closed = true;
    this.clearRetryTimer();
    this.controller.abort();
    this.jobs = [];
    this.blobs.clear();
  }
  private async raw(path: string, body?: unknown, signal:AbortSignal=this.controller.signal) {
    return fetch(`${this.base}/api${path}`, {method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${this.accessToken}`, 'Content-Type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), cache:'no-store', signal});
  }
  override async request<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error('连接已关闭');
    if (path === '/me') {
      if (!this.me || Date.now()-this.meAt > 30000) {
        this.me = await super.request<User>(path); this.meAt = Date.now();
      }
      return structuredClone(this.me) as T;
    }
    if (path === '/jobs') return {jobs:structuredClone(this.jobs), queue_paused:this.queuePaused,
      encoding:this.encoding, encoding_paused:Boolean(this.encodingWait && this.queuePaused), encoding_retry_at:this.encodingRetryAt,
      encoding_wait_reason:this.encodingWaitReason} as T;
    if (path === '/queue/pause' || path === '/queue/resume') {
      this.queuePaused = path === '/queue/pause';
      this.clearRetryTimer();
      if (this.queuePaused) this.encodingWait?.pause();
      else { this.encodingWait?.resume(); void this.pump(); }
      return {jobs:structuredClone(this.jobs), queue_paused:this.queuePaused} as T;
    }
    if (path === '/batches') {
      const batch = body as {request_id:string; items:Task[]};
      if (!this.batches.has(batch.request_id)) {
        this.checkCapacity(batch.items.length);
        this.batches.add(batch.request_id);
        for (const task of batch.items) this.jobs.push({...structuredClone(task), id:task.request_id, status:'queued', created_at:Date.now()/1000,
          results:[], quota_units:0, storage_mode:'browser', retention_hours:0});
        void this.pump();
      }
      return {jobs:structuredClone(this.jobs), queue_paused:this.queuePaused} as T;
    }
    const cancel = path.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (cancel) {
      const job = this.jobs.find(j => j.id === cancel[1]);
      if (!job || !['queued','waiting'].includes(job.status)) throw new Error('只能取消尚未发送或正在等待重试的任务');
      if (job.status === 'waiting') this.clearRetryTimer();
      job.status = 'cancelled'; job.completed_at = Date.now()/1000; delete job.retry_at; delete job.retry_reason;
      void this.pump();
      return structuredClone(job) as T;
    }
    const resource = path.match(/^\/results\/([^/]+)(\/ack)?$/);
    if (resource) {
      const result = this.jobs.flatMap(j=>j.results).find(r=>r.id === resource[1]);
      if (!result) throw new Error('本页结果不存在');
      if (resource[2]) {
        if ((body as {sha256:string}).sha256 !== result.sha256) throw new Error('本地保存校验不一致');
        result.acknowledged = true;
      } else if (method === 'DELETE') result.deleted = true;
      else throw new Error('不支持的结果操作');
      this.blobs.delete(result.id);
      void this.pump();
      return {acknowledged:result.acknowledged, deleted:result.deleted} as T;
    }
    return super.request<T>(path, body, method, signal);
  }
  async content(id: string) {
    const value = this.blobs.get(id);
    if (!value) throw new Error('结果已离开当前页面，请查看本机图库');
    return value;
  }
  private clearRetryTimer() {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  private scheduleRetry(job: PreviewJob, failure: ExecutionFailure) {
    job.retry_count = (job.retry_count ?? 0) + 1;
    job.status = 'waiting'; job.retry_at = Date.now()/1000 + retryDelay(failure, job.retry_count);
    job.retry_reason = waitReason(failure);
  }
  private async pump() {
    if (this.encoding || this.working || this.closed || this.queuePaused || this.jobs.some(j => j.results.some(r=>!r.acknowledged && !r.deleted))) return;
    const job = this.jobs.find(j=>j.status === 'queued' || j.status === 'waiting');
    if (!job) return;
    if (job.status === 'waiting' && (job.retry_at ?? 0) > Date.now()/1000) {
      if (this.retryTimer === undefined) this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined; void this.pump();
      }, Math.max(1, Math.ceil(((job.retry_at ?? 0) - Date.now()/1000) * 1000)));
      return;
    }
    this.clearRetryTimer();
    this.working = true;
    job.status = 'running'; job.started_at = Date.now()/1000; job.last_data_at=job.started_at;
    // In flight does not prove Gate has acquired a slot or dispatched generation.
    job.execution_phase = 'submitting';
    delete job.retry_at; delete job.retry_reason; delete job.error; delete job.completed_at;
    let receivedFinal = false, receivedOutput = false;
    const execution=linkedExecution(this.controller.signal);
    try {
      const task: Task = {request_id:job.request_id, operation:job.operation, model:job.model, prompt:job.prompt,
        negative_prompt:job.negative_prompt, parameters:{...job.parameters}, label:job.label};
      delete task.parameters.vibe_source_images;
      delete task.parameters.vibe_source_files;
      const response = await execution.wait(()=>this.raw('/execute',task,execution.signal),FETCH_TIMEOUT_MESSAGE);
      job.last_data_at=Date.now()/1000;
      if (!response.ok) {
        const error = await execution.wait(()=>response.json().catch(()=>({detail:`请求失败 (${response.status})`})),STREAM_TIMEOUT_MESSAGE);
        const detail = typeof error.detail === 'object' && error.detail !== null ? error.detail : error;
        throw new GateExecutionError(typeof detail.message === 'string' ? detail.message : typeof error.detail === 'string' ? error.detail : 'Gate 拒绝了请求',
          {...detail, uncertain:detail.uncertain ?? response.status >= 500});
      }
      if (!response.body) throw new Error('没有收到生成结果');
      job.execution_phase = 'waiting_result';
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', terminal=false,readDeadline=Date.now()+EXECUTION_TIMEOUT_MS;
      const processLine=(line:string) => {
        if(!line.trim())return;
        const event=parseEvent(line);
        if (event.type === 'preview') { receivedOutput = true; job.preview = event.preview; job.execution_phase = 'generating'; }
        if (event.type === 'error') throw new GateExecutionError(event.message, event);
        if (event.type === 'final') {
          terminal=true; receivedOutput=true;
          if (!Array.isArray(event.artifacts) || !event.artifacts.length) throw new Error('Gate 最终结果为空，完整结果未确认；请核对用量后再手动恢复');
          const completed=event.artifacts.map((artifact:any) => {
            if (!artifact || typeof artifact.data!=='string' || !artifact.data || typeof artifact.media_type!=='string' || !artifact.media_type ||
              typeof artifact.filename!=='string' || !artifact.filename || typeof artifact.sha256!=='string' || !artifact.sha256 ||
              !artifact.metadata || typeof artifact.metadata!=='object' || Array.isArray(artifact.metadata))
              throw new Error('Gate 最终图片数据不完整，完整结果未确认；请核对用量后再手动恢复');
            let bytes:Uint8Array;
            try { bytes=Uint8Array.from(atob(artifact.data),c=>c.charCodeAt(0)); }
            catch { throw new Error('Gate 最终图片数据损坏，完整结果未确认；请核对用量后再手动恢复'); }
            if(!bytes.length)throw new Error('Gate 最终图片为空，完整结果未确认；请核对用量后再手动恢复');
            const blob = new Blob([bytes], {type:artifact.media_type});
            const result: Result = {id:uuid(), job_id:job.id, filename:artifact.filename, sha256:artifact.sha256,
              media_type:artifact.media_type, size:blob.size, expires_at:0, deleted:false, acknowledged:false, metadata:artifact.metadata};
            return {result,blob};
          });
          for(const item of completed) { this.blobs.set(item.result.id,item.blob); job.results.push(item.result); }
          receivedFinal = true; job.status = 'succeeded'; delete job.preview;
        }
      };
      try { while (true) {
        const {done, value} = await execution.wait(()=>reader.read(),STREAM_TIMEOUT_MESSAGE,Math.max(1,readDeadline-Date.now()));
        if(value?.byteLength){readDeadline=Date.now()+EXECUTION_TIMEOUT_MS;job.last_data_at=Date.now()/1000;}
        buffer += decoder.decode(value, {stream:!done});
        if (buffer.length > 96*1024*1024) throw new Error('单个结果超过页面接收限制');
        let newline;
        while (!terminal && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0,newline); buffer=buffer.slice(newline+1);
          processLine(line);
        }
        if(done && !terminal && buffer.trim())processLine(buffer);
        if (done || terminal) break;
      } } finally { cancelReader(reader); }
      if (!receivedFinal) throw new Error('请求中断，未收到最终图；请核对 Gate 用量，勿直接重试');
    } catch (error) {
      job.error = error instanceof Error ? error.message : '生成失败';
      const failure = error instanceof GateExecutionError ? error.failure : undefined;
      if (mayRetry(failure, receivedOutput)) {
        this.scheduleRetry(job, failure!);
      } else {
        // Keep unsent work available. Only the explicitly rejected, recoverable requests above may repeat.
        job.status = receivedFinal ? 'succeeded' : receivedOutput || failure?.uncertain !== false ? 'unknown' : 'failed';
        this.queuePaused = true;
      }
    } finally {
      execution.dispose();
      delete job.execution_phase;
      if (job.retry_at === undefined) job.completed_at = Date.now()/1000;
      this.meAt = 0; this.working = false;
      if (!this.closed) void this.pump();
    }
  }
}
