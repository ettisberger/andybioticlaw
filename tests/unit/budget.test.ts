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

describe('budget tracker — manual reset anchor', () => {
  // Repo that sums only sessions whose `startedAt` falls in [from, to).
  function makeWindowedRepo(sessions: Array<{ startedAt: number; tokens: number }>) {
    return {
      tokensUsedBetween: (from: number, to: number) =>
        sessions
          .filter((s) => s.startedAt >= from && s.startedAt < to)
          .reduce((acc, s) => acc + s.tokens, 0),
      create: () => {},
      update: () => {},
      get: () => null,
      list: () => [],
      markRunningAsOrphaned: () => ({ count: 0, chatIds: [] }),
    };
  }

  function stateRepo(anchor: number | null) {
    let value = anchor;
    return {
      getResetAnchor: () => value,
      setResetAnchor: (ms: number | null) => {
        value = ms;
      },
    };
  }

  const cfg = () => ({
    dailyTokenLimit: 1000,
    perSessionTokenLimit: 200,
    dailyResetTime: '00:00',
    timezone: 'UTC',
  });

  const noon = Date.UTC(2026, 3, 21, 12, 0, 0);
  const tenAm = Date.UTC(2026, 3, 21, 10, 0, 0);
  const threePm = Date.UTC(2026, 3, 21, 15, 0, 0);
  const fourPm = Date.UTC(2026, 3, 21, 16, 0, 0);

  it('ignores a null anchor — uses the natural window', () => {
    const t = createBudgetTracker(
      makeWindowedRepo([{ startedAt: tenAm, tokens: 400 }]) as never,
      cfg,
      stateRepo(null),
    );
    const s = t.status(noon);
    expect(s.used).toBe(400);
    expect(s.window.manualResetAt).toBeNull();
  });

  it('honors an anchor inside the current window — excludes earlier sessions', () => {
    // 400 tokens used before the anchor, 300 after. Resetting at noon
    // drops the earlier 400 out of the window.
    const t = createBudgetTracker(
      makeWindowedRepo([
        { startedAt: tenAm, tokens: 400 },
        { startedAt: threePm, tokens: 300 },
      ]) as never,
      cfg,
      stateRepo(noon),
    );
    const s = t.status(fourPm);
    expect(s.used).toBe(300);
    expect(s.window.manualResetAt).toBe(noon);
    expect(s.window.fromMs).toBe(noon);
  });

  it('ignores a stale anchor from a previous window', () => {
    // Anchor set yesterday — natural reset at 00:00 already retired it.
    const yesterday = Date.UTC(2026, 3, 20, 15, 0, 0);
    const t = createBudgetTracker(
      makeWindowedRepo([{ startedAt: tenAm, tokens: 400 }]) as never,
      cfg,
      stateRepo(yesterday),
    );
    const s = t.status(noon);
    expect(s.used).toBe(400);
    expect(s.window.manualResetAt).toBeNull();
  });
});
