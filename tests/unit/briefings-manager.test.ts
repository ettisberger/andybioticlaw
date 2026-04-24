import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSchedulesRepo } from '../../src/db/repositories/schedules.js';
import {
  createBriefingManager,
  cronToTime,
  timeToCron,
} from '../../src/cli/briefings/manager.js';

/**
 * The briefings manager is a thin wrapper over `schedules`, but the
 * contract matters — the Settings menu assumes:
 *   - enable() creates or updates a row with the right name + cron + payload.
 *   - disable() leaves the row present but disabled (so reverting is cheap).
 *   - setTime() patches the cron; never changes the enabled flag.
 *   - getStatus() round-trips cron back to HH:MM correctly.
 */

const MIGRATIONS = [
  '0001_init.sql',
  '0002_memory_proposals_skill_state.sql',
  '0004_schedules_one_shot.sql',
];

function makeDb() {
  const db = new Database(':memory:');
  for (const f of MIGRATIONS) {
    db.exec(readFileSync(resolve(__dirname, '..', '..', 'src', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

describe('timeToCron / cronToTime', () => {
  it('timeToCron builds a daily-fire cron string', () => {
    expect(timeToCron('07:30')).toBe('30 7 * * *');
    expect(timeToCron('00:00')).toBe('0 0 * * *');
    expect(timeToCron('23:59')).toBe('59 23 * * *');
  });

  it('timeToCron rejects malformed input', () => {
    expect(() => timeToCron('25:00')).toThrow();
    expect(() => timeToCron('7:30')).toThrow(); // no leading zero
    expect(() => timeToCron('07-30')).toThrow();
  });

  it('cronToTime recovers HH:MM from a daily-fire cron', () => {
    expect(cronToTime('30 7 * * *', '00:00')).toBe('07:30');
    expect(cronToTime('0 0 * * *', 'x')).toBe('00:00');
  });

  it('cronToTime returns the fallback for non-daily expressions', () => {
    expect(cronToTime('30 7 * * 1', '09:00')).toBe('09:00'); // Mondays only
    expect(cronToTime('garbage', '09:00')).toBe('09:00');
    expect(cronToTime('30 25 * * *', '09:00')).toBe('09:00'); // bad hour
  });
});

describe('BriefingManager', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('getStatus returns defaults when no schedule exists', () => {
    const bm = createBriefingManager({ schedules: createSchedulesRepo(db) });
    const s = bm.getStatus();
    expect(s.morning).toEqual({ kind: 'morning', enabled: false, time: '07:30' });
    expect(s.evening).toEqual({ kind: 'evening', enabled: false, time: '18:30' });
  });

  it('enable(morning, 08:15) creates a schedule with the right shape', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.enable('morning', '08:15');
    const row = repo.getByName('morning-briefing');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('agent-task');
    expect(row!.cron_expr).toBe('15 8 * * *');
    expect(row!.enabled).toBe(1);
    expect(row!.budget_tokens_per_day).toBeGreaterThan(0);
    const payload = JSON.parse(row!.payload) as { prompt: string };
    expect(payload.prompt).toMatch(/morning briefing/i);
  });

  it('disable flips enabled=0 but preserves the row (and cron)', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.enable('morning', '08:15');
    bm.disable('morning');
    const row = repo.getByName('morning-briefing');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
    expect(row!.cron_expr).toBe('15 8 * * *');
  });

  it('setTime changes only the cron expression, not enabled', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.enable('evening', '18:00');
    bm.setTime('evening', '19:45');
    const row = repo.getByName('evening-briefing');
    expect(row!.cron_expr).toBe('45 19 * * *');
    expect(row!.enabled).toBe(1); // still armed
  });

  it('setTime on a not-yet-created briefing creates it DISABLED', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.setTime('morning', '06:00');
    const row = repo.getByName('morning-briefing');
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(0);
    expect(row!.cron_expr).toBe('0 6 * * *');
  });

  it('enable() on an existing disabled row re-arms + keeps the time', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.enable('evening', '18:00');
    bm.disable('evening');
    bm.enable('evening', '20:00');
    const row = repo.getByName('evening-briefing');
    expect(row!.enabled).toBe(1);
    expect(row!.cron_expr).toBe('0 20 * * *');
  });

  it('calls onChange after each mutation', () => {
    const repo = createSchedulesRepo(db);
    let count = 0;
    const bm = createBriefingManager({ schedules: repo, onChange: () => (count += 1) });
    bm.enable('morning', '07:00');
    bm.setTime('morning', '08:00');
    bm.disable('morning');
    expect(count).toBe(3);
  });

  it('getStatus round-trips enable + setTime correctly', () => {
    const repo = createSchedulesRepo(db);
    const bm = createBriefingManager({ schedules: repo });
    bm.enable('morning', '09:15');
    bm.enable('evening', '21:00');
    const s = bm.getStatus();
    expect(s.morning).toEqual({ kind: 'morning', enabled: true, time: '09:15' });
    expect(s.evening).toEqual({ kind: 'evening', enabled: true, time: '21:00' });
  });
});
