import { ApiError } from './api';
import type { Api } from './api';
import { uuid } from './types';
import type { Task } from './types';

export type ImageQueueOperation = 'generate-image' | 'upscale' | 'augment-image' | 'encode-vibe';
export type ImageQueueTicket = {
  ticket_id: string;
  request_id: string;
  operation: ImageQueueOperation;
  state: 'queued' | 'ready' | 'active' | 'finished' | 'cancelled' | 'expired';
  position: number;
  expires_in: number;
  poll_after: number;
};

export function queueOperation(operation: Task['operation']): ImageQueueOperation {
  switch (operation) {
    case 'generate': case 'img2img': case 'inpaint': return 'generate-image';
    case 'upscale': return 'upscale';
    case 'augment': return 'augment-image';
    case 'encode_vibe': return 'encode-vibe';
  }
}

const cancelledError = () => new DOMException('排队等待已取消', 'AbortError');

export class ImageQueueWait {
  readonly request_id = uuid();
  private currentTicket?: ImageQueueTicket;
  private createAttempted = false;
  private stopped = false;
  private disposed = false;
  private waitController = new AbortController();
  private cancelController = new AbortController();
  private waiting?: Promise<ImageQueueTicket>;
  private cancelling?: Promise<boolean>;
  private onClose = () => { void this.cancel(); };

  constructor(
    private api: Pick<Api, 'request'>,
    private operation: ImageQueueOperation,
    private closeSignal: AbortSignal,
    private onStatus: (ticket: ImageQueueTicket | undefined) => void,
    private requiresAnlas = false,
  ) {
    if (closeSignal.aborted) this.onClose();
    else closeSignal.addEventListener('abort', this.onClose, { once: true });
  }

  get ticket() { return this.currentTicket; }

  wait(): Promise<ImageQueueTicket> {
    if (this.stopped) return Promise.reject(cancelledError());
    return this.waiting ??= this.run();
  }

  cancel(): Promise<boolean> {
    return this.cancelling ??= this.cancelTicket();
  }

  dispose() {
    this.disposed = true;
    this.stopped = true;
    this.closeSignal.removeEventListener('abort', this.onClose);
    this.waitController.abort();
    this.cancelController.abort();
  }

  private notify(ticket: ImageQueueTicket | undefined) {
    if (!this.disposed) this.onStatus(ticket);
  }

  private readTicket(value: unknown): ImageQueueTicket {
    const ticket = value as ImageQueueTicket | null;
    if (!ticket || typeof ticket.ticket_id !== 'string' || !ticket.ticket_id ||
        ticket.request_id !== this.request_id || ticket.operation !== this.operation ||
        !['queued', 'ready', 'active', 'finished', 'cancelled', 'expired'].includes(ticket.state) ||
        !Number.isInteger(ticket.position) || (ticket.state === 'queued' ? ticket.position < 1 : ticket.position !== 0) ||
        !Number.isFinite(ticket.expires_in) || ticket.expires_in < 0 ||
        !Number.isFinite(ticket.poll_after) || ticket.poll_after < 0 ||
        (ticket.state === 'queued' && ticket.poll_after === 0))
      throw new Error('排队服务返回了无效票据，本次尚未提交生图');
    if (this.currentTicket && ticket.ticket_id !== this.currentTicket.ticket_id)
      throw new Error('排队票据发生变化，本次尚未提交生图');
    return ticket;
  }

  private create(signal: AbortSignal) {
    this.createAttempted = true;
    return this.rpc('/image-queue', { request_id: this.request_id, operation: this.operation,
      ...(this.requiresAnlas ? { requires_anlas: true } : {}) }, 'POST', signal);
  }

  private ticketPath(ticket: ImageQueueTicket) {
    return `/image-queue/${encodeURIComponent(ticket.ticket_id)}`;
  }

  private async run(): Promise<ImageQueueTicket> {
    let failures = 0;
    while (true) {
      if (this.stopped) throw cancelledError();
      let value: unknown;
      try {
        value = this.currentTicket
          ? await this.rpc(`${this.ticketPath(this.currentTicket)}/heartbeat`, undefined, 'POST', this.waitController.signal)
          : await this.create(this.waitController.signal);
      } catch (error) {
        if (this.stopped) throw cancelledError();
        if (error instanceof SyntaxError)
          throw new Error('排队服务返回的数据格式无效，本次尚未提交生图');
        if (error instanceof ApiError && error.status < 500) throw error;
        this.notify(undefined);
        if (++failures >= 3)
          throw new Error('排队连接连续失败，本次尚未提交生图；请稍后重新排队');
        await this.delay(3000);
        continue;
      }
      if (this.stopped) throw cancelledError();
      const ticket = this.readTicket(value);
      this.currentTicket = ticket;
      this.notify(ticket);
      if (ticket.state === 'ready') return ticket;
      if (ticket.state === 'expired') throw new Error('排队票据已过期，本次尚未提交生图');
      if (ticket.state === 'cancelled') throw cancelledError();
      if (ticket.state !== 'queued') throw new Error('这张排队票据已开始或已完成，不能重复提交');
      failures = 0;
      await this.delay(Math.max(1000, ticket.poll_after * 1000));
    }
  }

  private async cancelTicket(): Promise<boolean> {
    this.stopped = true;
    this.waitController.abort();
    if (!this.createAttempted && !this.currentTicket) return true;
    try {
      // Recover a lost create response with the same id before attempting deletion.
      let ticket = this.currentTicket ?? this.readTicket(await this.create(this.cancelController.signal));
      this.currentTicket = ticket;
      if (ticket.state === 'queued' || ticket.state === 'ready') {
        ticket = this.readTicket(await this.rpc(this.ticketPath(ticket), undefined, 'DELETE', this.cancelController.signal));
        this.currentTicket = ticket;
      }
      this.notify(ticket);
      return ticket.state === 'cancelled' || ticket.state === 'expired';
    } catch {
      // A failed cancellation or a claimed ticket is not proof that nothing ran.
      this.notify(undefined);
      return false;
    }
  }

  private delay(milliseconds: number): Promise<void> {
    const signal = this.waitController.signal;
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { clear(); reject(cancelledError()); };
      const timer = setTimeout(() => { clear(); resolve(); }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private rpc(path: string, body: unknown, method: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(cancelledError());
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        complete();
      };
      const abort = () => {
        controller.abort();
        finish(() => reject(cancelledError()));
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish(() => reject(new Error('排队状态请求超时')));
      }, 10_000);
      signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve().then(() => {
        if (!settled) return this.api.request(path, body, method, controller.signal);
      }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
}
