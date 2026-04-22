import { describe, it, expect } from 'vitest';
import { RollingRateLimiter } from '../../src/telegram/streaming.js';

describe('RollingRateLimiter', () => {
  it('allows up to the limit within the window', () => {
    const rl = new RollingRateLimiter(3, 1000);
    const t0 = 10_000;
    expect(rl.canAcquire(t0)).toBe(true);
    rl.record(t0);
    rl.record(t0 + 10);
    rl.record(t0 + 20);
    expect(rl.canAcquire(t0 + 30)).toBe(false);
  });

  it('releases capacity once events age out', () => {
    const rl = new RollingRateLimiter(3, 1000);
    const t0 = 10_000;
    rl.record(t0);
    rl.record(t0 + 100);
    rl.record(t0 + 200);
    expect(rl.canAcquire(t0 + 300)).toBe(false);
    // after the window, the oldest drops
    expect(rl.canAcquire(t0 + 1100)).toBe(true);
  });

  it('count() reports current window size', () => {
    const rl = new RollingRateLimiter(10, 500);
    const t0 = 0;
    for (let i = 0; i < 5; i++) rl.record(t0 + i * 50);
    // At t0+250 all 5 events are in the [t0-250, t0+250] window.
    expect(rl.count(t0 + 250)).toBe(5);
    // At t0+400 the cutoff is -100 (all events still in).
    expect(rl.count(t0 + 400)).toBe(5);
    // At t0+600 cutoff is 100, so events at 0 and 50 age out; 100/150/200 remain.
    expect(rl.count(t0 + 600)).toBe(3);
    // At t0+800 cutoff is 300; all events gone.
    expect(rl.count(t0 + 800)).toBe(0);
  });
});
