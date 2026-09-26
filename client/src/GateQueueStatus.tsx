import { useEffect, useState } from 'react';
import type { Api } from './api';
import type { Job, QueueWaitReason } from './types';

type Snapshot = {
  global: { active: number; waiting: number; concurrency: number };
  image_cooldown_remaining: number;
  sampled_at: number;
};
type Monitor = { api: Api | null; snapshot?: Snapshot; receivedAt?: number; unavailable?: boolean };
const waitLabels: Record<QueueWaitReason, string> = {
  rpm: '请求频率受限', cooldown: '图片服务冷却中',
  key_busy: '等待此 Key 的并发空位', service_busy: '服务繁忙，等待重试',
};
export const queueWaitLabel = (reason?: QueueWaitReason) => reason ? waitLabels[reason] : '等待重试';
export function gateJobLabel(job: Job, now = Date.now() / 1000) {
  if (job.status === 'queued') return '本机待发送';
  if (job.status === 'waiting') return queueWaitLabel(job.retry_reason);
  if (job.status === 'running' && now - (job.last_data_at ?? job.started_at ?? now) >= 60)
    return '暂未收到新数据，仍在等待结果';
  if (job.status === 'running') return job.execution_phase === 'generating' ? '生成中' :
    job.execution_phase === 'submitting' ? '正在提交' : '等待服务器结果';
  return undefined;
}
function validSnapshot(value: Snapshot) {
  const g = value?.global;
  return g && [g.active, g.waiting, g.concurrency].every(n => Number.isInteger(n) && n >= 0) && g.concurrency >= 1 &&
    Number.isFinite(value.image_cooldown_remaining) && value.image_cooldown_remaining >= 0 &&
    Number.isFinite(value.sampled_at) && value.sampled_at > 0;
}
export function useGateQueueStatus(api: Api | null, enabled: boolean): Monitor {
  const currentApi = enabled ? api : null;
  const [state, setState] = useState<Monitor>({ api: null });
  useEffect(() => {
    setState({ api: currentApi });
    if (!currentApi) return;
    let stopped = false, running = false;
    let lastSample: { sampledAt: number; receivedAt: number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function poll() {
      if (stopped || running) return;
      running = true;
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 8000);
      try {
        // This is an aggregate Gate snapshot, never a job position or a retry signal.
        const snapshot = await currentApi!.request<Snapshot>('/queue-status', undefined, undefined, controller.signal);
        if (!validSnapshot(snapshot)) throw new Error('Invalid queue snapshot');
        if (!stopped) {
          // Server and browser clocks can differ. Age a sample on the local
          // monotonic clock, retaining its first receipt when the cache repeats it.
          const receivedAt = lastSample?.sampledAt === snapshot.sampled_at ? lastSample.receivedAt : performance.now();
          lastSample = { sampledAt: snapshot.sampled_at, receivedAt };
          setState({ api: currentApi, snapshot, receivedAt });
        }
      } catch {
        if (!stopped) setState(previous => {
          // One failed queue poll does not mean generation is unavailable.
          if (previous.api === currentApi && previous.snapshot && previous.receivedAt !== undefined &&
              performance.now() - previous.receivedAt <= 15000) return previous;
          return { api: currentApi, unavailable: true };
        });
      } finally {
        clearTimeout(deadline);
        running = false;
        if (!stopped) timer = setTimeout(() => void poll(), 5000);
      }
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || running) return;
      clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [currentApi]);
  return state.api === currentApi ? state : { api: currentApi };
}
export default function GateQueueStatus({ monitor }: { monitor: Monitor }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!monitor.api) return;
    // Update the countdown locally; this does not increase the polling rate.
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [monitor.api]);
  if (!monitor.api) return null;
  const snapshot = monitor.snapshot;
  const age = monitor.receivedAt === undefined ? 0 : Math.max(0, (performance.now() - monitor.receivedAt) / 1000);
  if (monitor.unavailable || (snapshot && age > 15))
    return <span>排队状态暂不可用</span>;
  if (!snapshot) return <span>读取排队状态…</span>;
  const cooldown = Math.max(0, Math.ceil(snapshot.image_cooldown_remaining - age));
  return <span>全站：占用 {snapshot.global.active}/{snapshot.global.concurrency} · 排队 {snapshot.global.waiting}
    {cooldown > 0 && <> · 冷却约 {cooldown} 秒</>}</span>;
}
