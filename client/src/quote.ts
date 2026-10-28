import type { Task } from './types';

export type ImageQuote = {
  source: 'gate';
  effective_model?: string;
  requested_model?: string;
  units: number;
  unit_label: string;
  generation_units?: number;
  encoding_units?: number;
  verified: boolean;
  message: string;
  cost_limit: { anlas: number; v5: number };
  encoding_cost_limit: { anlas: number; v5: number };
  output_size?: [number, number] | null;
};

export function withQuote(task: Task, quote: ImageQuote | null): Task {
  if (quote?.source !== 'gate' || !quote.cost_limit || !quote.encoding_cost_limit)
    throw new Error('请先取得 Gate 报价，再提交任务');
  return { ...task, cost_limit: { ...quote.cost_limit },
    parameters: { ...task.parameters, vibe_encoding_cost_limit: { ...quote.encoding_cost_limit } } };
}
