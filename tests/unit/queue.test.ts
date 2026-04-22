import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { createChatRunner, createQueueManager, QueueCancelledError } from '../../src/agent/queue.js';

const logger = pino({ level: 'silent' });

describe('ChatRunner', () => {
  it('runs tasks sequentially in FIFO order', async () => {
    const order: number[] = [];
    const runner = createChatRunner<number, number>({
      chatId: 'c1',
      logger,
      run: async (n) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(n);
        return n * 2;
      },
    });
    const results = await Promise.all([1, 2, 3].map((n) => runner.submit(n)));
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([2, 4, 6]);
    expect(runner.depth()).toBe(0);
  });

  it('reports busy while current running and queue depth', async () => {
    const runner = createChatRunner<number, number>({
      chatId: 'c1',
      logger,
      run: async (n) => {
        await new Promise((r) => setTimeout(r, 30));
        return n;
      },
    });
    const p1 = runner.submit(1);
    const p2 = runner.submit(2);
    // synchronously after submit, both are tracked
    expect(runner.depth()).toBe(2);
    expect(runner.isBusy()).toBe(true);
    await Promise.all([p1, p2]);
    expect(runner.depth()).toBe(0);
  });

  it('cancel aborts current and drops queued', async () => {
    const dropped: number[] = [];
    const runner = createChatRunner<number, number>({
      chatId: 'c1',
      logger,
      run: async (n, signal) => {
        return new Promise<number>((resolve, reject) => {
          const t = setTimeout(() => resolve(n), 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      },
      onDrop: (req) => dropped.push(req),
    });

    const p1 = runner.submit(1).catch((e) => e);
    const p2 = runner.submit(2).catch((e) => e);
    const p3 = runner.submit(3).catch((e) => e);

    // Tiny delay so p1 actually starts running.
    await new Promise((r) => setTimeout(r, 10));
    const out = runner.cancel();
    expect(out.cancelledCurrent).toBe(true);
    expect(out.droppedQueued).toBe(2);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect((r1 as Error).message).toBe('aborted');
    expect(r2).toBeInstanceOf(QueueCancelledError);
    expect(r3).toBeInstanceOf(QueueCancelledError);
    expect(dropped).toEqual([2, 3]);
  });
});

describe('QueueManager', () => {
  it('isolates chats', async () => {
    const qm = createQueueManager<number, number>({
      logger,
      makeRunner: (chatId) =>
        createChatRunner({
          chatId,
          logger,
          run: async (n) => {
            await new Promise((r) => setTimeout(r, 20));
            return n * 10;
          },
        }),
    });

    const p1 = qm.submit('A', 1);
    const p2 = qm.submit('B', 2);
    // A and B run in parallel because they are different chats.
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(10);
    expect(b).toBe(20);
  });

  it('depths() skips idle chats', async () => {
    const qm = createQueueManager<number, number>({
      logger,
      makeRunner: (chatId) =>
        createChatRunner({
          chatId,
          logger,
          run: async (n) => {
            await new Promise((r) => setTimeout(r, 15));
            return n;
          },
        }),
    });
    const p = qm.submit('A', 1);
    qm.submit('A', 2).catch(() => {});
    expect(qm.depths()).toEqual({ A: 2 });
    await p;
  });
});
