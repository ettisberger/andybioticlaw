import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';

export interface QueuedTask<TReq, TRes> {
  req: TReq;
  enqueuedAt: number;
  onStart?: () => void;
  onSkipped?: (reason: string) => void;
  resolve: (result: TRes) => void;
  reject: (err: unknown) => void;
}

export interface ChatRunnerDeps<TReq, TRes> {
  chatId: string;
  logger: Logger;
  /** Called for each submitted task. Return a promise that resolves with the result. */
  run: (req: TReq, signal: AbortSignal) => Promise<TRes>;
  /** Called when a queued task is dropped by `cancel()`. `TRes` is NOT produced. */
  onDrop?: (req: TReq) => void;
}

export interface ChatRunner<TReq, TRes> {
  submit(req: TReq, onStart?: () => void): Promise<TRes>;
  cancel(): { cancelledCurrent: boolean; droppedQueued: number };
  depth(): number;
  isBusy(): boolean;
}

export function createChatRunner<TReq, TRes>(
  deps: ChatRunnerDeps<TReq, TRes>,
): ChatRunner<TReq, TRes> {
  const queued: QueuedTask<TReq, TRes>[] = [];
  let current: {
    task: QueuedTask<TReq, TRes>;
    controller: AbortController;
  } | null = null;

  function startNext(): void {
    if (current) return;
    const next = queued.shift();
    if (!next) return;

    const controller = new AbortController();
    current = { task: next, controller };
    next.onStart?.();

    deps
      .run(next.req, controller.signal)
      .then(
        (result) => next.resolve(result),
        (err) => next.reject(err),
      )
      .finally(() => {
        current = null;
        startNext();
      });
  }

  return {
    submit(req, onStart) {
      return new Promise<TRes>((resolve, reject) => {
        const task: QueuedTask<TReq, TRes> = {
          req,
          enqueuedAt: Date.now(),
          ...(onStart ? { onStart } : {}),
          resolve,
          reject,
        };
        queued.push(task);
        startNext();
      });
    },
    cancel() {
      const droppedQueued = queued.length;
      for (const q of queued) {
        deps.onDrop?.(q.req);
        q.reject(new QueueCancelledError('cleared by cancel'));
      }
      queued.length = 0;
      let cancelledCurrent = false;
      if (current) {
        current.controller.abort();
        cancelledCurrent = true;
      }
      return { cancelledCurrent, droppedQueued };
    },
    depth() {
      return queued.length + (current ? 1 : 0);
    },
    isBusy() {
      return current !== null;
    },
  };
}

export class QueueCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueCancelledError';
  }
}

/** Map of chat id → ChatRunner. Emits `busy-change` for heartbeat snapshot. */
export interface QueueManagerDeps<TReq, TRes> {
  logger: Logger;
  makeRunner: (chatId: string) => ChatRunner<TReq, TRes>;
}

export interface QueueManager<TReq, TRes> extends EventEmitter {
  submit(chatId: string, req: TReq, onStart?: () => void): Promise<TRes>;
  cancel(chatId: string): { cancelledCurrent: boolean; droppedQueued: number };
  depth(chatId: string): number;
  totalDepth(): number;
  depths(): Record<string, number>;
  isAnyBusy(): boolean;
}

export function createQueueManager<TReq, TRes>(
  deps: QueueManagerDeps<TReq, TRes>,
): QueueManager<TReq, TRes> {
  const chats = new Map<string, ChatRunner<TReq, TRes>>();
  const emitter = new EventEmitter();

  function runnerFor(chatId: string) {
    let r = chats.get(chatId);
    if (!r) {
      r = deps.makeRunner(chatId);
      chats.set(chatId, r);
    }
    return r;
  }

  return Object.assign(emitter, {
    submit(chatId: string, req: TReq, onStart?: () => void) {
      return runnerFor(chatId).submit(req, onStart);
    },
    cancel(chatId: string) {
      const r = chats.get(chatId);
      if (!r) return { cancelledCurrent: false, droppedQueued: 0 };
      return r.cancel();
    },
    depth(chatId: string) {
      return chats.get(chatId)?.depth() ?? 0;
    },
    totalDepth() {
      let sum = 0;
      for (const r of chats.values()) sum += r.depth();
      return sum;
    },
    depths() {
      const out: Record<string, number> = {};
      for (const [id, r] of chats.entries()) {
        const d = r.depth();
        if (d > 0) out[id] = d;
      }
      return out;
    },
    isAnyBusy() {
      for (const r of chats.values()) {
        if (r.isBusy()) return true;
      }
      return false;
    },
  });
}
