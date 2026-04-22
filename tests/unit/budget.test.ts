import { describe, it, expect } from 'vitest';
import { currentWindow, createBudgetTracker } from '../../src/agent/budget.js';

describe('budget window math (Europe/Zurich, reset 00:00)', () => {
  const zone = 'Europe/Zurich';

  it('returns today midnight-to-midnight for a mid-day time', () => {
    // 2026-04-21 12:00 local = 10:00 UTC
    const now = Date.UTC(2026, 3, 21, 10, 0, 0);
    const w = currentWindow(now, '00:00', zone);
    // Window start: 2026-04-21 00:00 local = 2026-04-20 22:00 UTC (CEST offset +2)
    expect(new Date(w.fromMs).toISOString()).toBe('2026-04-20T22:00:00.000Z');
    expect(new Date(w.toMs).toISOString()).toBe('2026-04-21T22:00:00.000Z');
  });

  it('when before reset time, the current window started "yesterday"', () => {
    // reset at 03:00 local. now = 01:30 local. Window starts YESTERDAY 03:00.
    const now = Date.UTC(2026, 3, 21, 23, 30, 0); // 2026-04-22 01:30 local (CEST +2)
    const w = currentWindow(now, '03:00', zone);
    expect(new Date(w.fromMs).toISOString()).toBe('2026-04-21T01:00:00.000Z'); // 03:00 local → 01:00 UTC CEST
    expect(new Date(w.toMs).toISOString()).toBe('2026-04-22T01:00:00.000Z');
  });

  it('handles DST spring-forward (Europe/Zurich, 2026-03-29)', () => {
    // In 2026 EU DST starts 2026-03-29 at 02:00 → 03:00 local.
    const now = Date.UTC(2026, 2, 29, 10, 0, 0); // 12:00 CEST
    const w = currentWindow(now, '00:00', zone);
    // 2026-03-29 00:00 CET = 2026-03-28 23:00 UTC
    expect(new Date(w.fromMs).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // 2026-03-30 00:00 CEST = 2026-03-29 22:00 UTC
    expect(new Date(w.toMs).toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});

describe('budget tracker', () => {
  function makeRepo(used: number) {
    return {
      tokensUsedBetween: () => used,
      create: () => {},
      update: () => {},
      get: () => null,
      list: () => [],
      markRunningAsOrphaned: () => ({ count: 0, chatIds: [] }),
    };
  }

  const cfg = () => ({
    dailyTokenLimit: 1000,
    perSessionTokenLimit: 200,
    dailyResetTime: '00:00',
    timezone: 'UTC',
  });

  it('reports remaining/used correctly', () => {
    const t = createBudgetTracker(makeRepo(300) as never, cfg);
    const s = t.status(Date.UTC(2026, 3, 21, 10, 0));
    expect(s.used).toBe(300);
    expect(s.remaining).toBe(700);
    expect(s.exhausted).toBe(false);
    expect(t.canStart()).toBe(true);
  });

  it('flips exhausted when used >= dailyLimit', () => {
    const t = createBudgetTracker(makeRepo(1000) as never, cfg);
    expect(t.status().exhausted).toBe(true);
    expect(t.canStart()).toBe(false);
    expect(t.exhaustedMessage()).toMatch(/exhausted/i);
  });
});
