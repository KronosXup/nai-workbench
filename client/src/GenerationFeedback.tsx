import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Job } from './types';
import './generationFeedback.css';

type FeedbackJob = Job & { preview?: { step?: number } };

export function generationRunKey(job: Job): string {
  return `${job.id}:${job.started_at ?? job.created_at}`;
}

export function generationFeedbackPhase(job: Job | undefined, observedRun: string | undefined,
  dismissedRun: string | undefined): 'running' | 'done' | 'hidden' {
  if (!job) return 'hidden';
  if (job.status === 'running') return 'running';
  const key = generationRunKey(job);
  return job.status === 'succeeded' && key === observedRun && key !== dismissedRun ? 'done' : 'hidden';
}

export function generationEstimateMs(job: Job, recentJobs: Job[]): number | undefined {
  const durations = recentJobs.filter(item => item.id !== job.id && item.status === 'succeeded'
    && item.model === job.model && item.operation === job.operation
    && Number.isFinite(item.started_at) && Number.isFinite(item.completed_at)
    && item.completed_at! > item.started_at!)
    .sort((a, b) => b.completed_at! - a.completed_at!).slice(0, 7)
    .map(item => (item.completed_at! - item.started_at!) * 1000).sort((a, b) => a - b);
  if (!durations.length) return undefined;
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
}

export default function GenerationProgress({ job, recentJobs = [] }: { job?: FeedbackJob; recentJobs?: Job[] }) {
  const key = job ? generationRunKey(job) : undefined;
  const observedRun = useRef<string | undefined>(undefined);
  const [dismissedRun, setDismissedRun] = useState<string | undefined>(undefined);
  const phase = generationFeedbackPhase(job, observedRun.current, dismissedRun);
  // Polling may replace job objects; freeze the estimate for this run's CSS clock.
  const timing = useMemo(() => ({
    estimate: job ? generationEstimateMs(job, recentJobs) : undefined,
    elapsed: job?.started_at ? Math.max(0, Date.now() - job.started_at * 1000) : 0,
  }), [key]);

  useLayoutEffect(() => {
    if (job?.status === 'running') {
      observedRun.current = key;
      setDismissedRun(undefined);
      return;
    }
    if (job?.status === 'succeeded' && key === observedRun.current) {
      const timer = window.setTimeout(() => {
        observedRun.current = undefined;
        setDismissedRun(key);
      }, 430);
      return () => window.clearTimeout(timer);
    }
    observedRun.current = undefined;
  }, [key, job?.status]);

  if (!job || phase === 'hidden') return null;
  const step = job.preview?.step, steps = job.parameters.steps;
  const streamed = typeof step === 'number' && Number.isFinite(step) && step >= 0 && Number.isFinite(steps) && steps > 0;
  const mode = phase === 'done' ? 'done' : streamed ? 'streaming' : timing.estimate ? 'estimating' : 'indeterminate';
  const style: CSSProperties = mode === 'done' ? { width: '100%' }
    : streamed ? { width: `${Math.min(92, step! / steps * 100)}%` }
    : mode === 'estimating' ? { animationDuration: `${timing.estimate}ms`, animationDelay: `${-timing.elapsed}ms` } : {};
  return <div key={key} className={`nai-generation-progress is-${mode}`} role="progressbar"
    aria-label={phase === 'done' ? '生成完成' : '正在生成图片'} aria-valuenow={phase === 'done' ? 100 : undefined}
    aria-valuemin={0} aria-valuemax={100}>
    <span style={style} />
  </div>;
}

export function GenerationPlaceholder({ width = 832, height = 1216, compact = false }:
  { width?: number; height?: number; compact?: boolean }) {
  const w = Math.max(2, width), h = Math.max(2, height);
  return <div className={`nai-generation-placeholder${compact ? ' is-compact' : ''}`}
    style={{ '--generation-ratio': `${w} / ${h}` } as CSSProperties} role="img" aria-label="正在生成图片">
    <svg className="nai-generation-frame" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x="1" y="1" width={w - 2} height={h - 2} rx="8" vectorEffect="non-scaling-stroke" />
    </svg>
    <span className="nai-generation-dots" aria-hidden="true"><i /><i /><i /></span>
  </div>;
}
