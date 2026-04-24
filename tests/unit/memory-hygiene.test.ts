import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { createMemoryRepo } from '../../src/db/repositories/memory.js';
import { createMemoryManager } from '../../src/memory/manager.js';

/**
 * `last_used_at` + `pinned` are the two columns that give the operator
 * a way to see which memories are load-bearing (recently read into
 * Emma's context) vs stale, and to protect valuable ones from pruning.
 *
 * These tests pin the three things that must be true for the dashboard
 * to be trustworthy:
 *   - snapshot() bumps last_used_at for the rows it returns.
 *   - setPinned() flips the flag (boolean in, 0/1 out of SQLite).
 *   - listActive() reads the two new fields back.
 */

const MIGRATIONS = [
  '0001_init.sql',
  '0002_memory_proposals_skill_state.sql',
  '0007_memory_hygiene.sql',
];

function makeDb() {
  const db = new Database(':memory:');
  for (const f of MIGRATIONS) {
    db.exec(readFileSync(resolve(__dirname, '..', '..', 'src', 'db', 'migrations', f), 'utf8'));
  }
  return db;
}

describe('memory hygiene — last_used_at + pinned', () => {
  let db: ReturnType<typeof makeDb>;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    db = makeDb();
  });

  it('new rows start with null last_used_at and pinned=0', () => {
    const repo = createMemoryRepo(db);
    const row = repo.create({ scope: 'global', value: 'hello', source: 'manual' });
    expect(row.last_used_at).toBeNull();
    expect(row.pinned).toBe(0);
  });

  it('bumpLastUsed updates multiple rows in one call', () => {
    const repo = createMemoryRepo(db);
    const a = repo.create({ scope: 'global', value: 'a', source: 'manual' });
    const b = repo.create({ scope: 'global', value: 'b', source: 'manual' });
    const c = repo.create({ scope: 'global', value: 'c', source: 'manual' });
    repo.bumpLastUsed([a.id, b.id], 1_700_000_000_000);
    expect(repo.get(a.id)!.last_used_at).toBe(1_700_000_000_000);
    expect(repo.get(b.id)!.last_used_at).toBe(1_700_000_000_000);
    expect(repo.get(c.id)!.last_used_at).toBeNull();
  });

  it('bumpLastUsed with empty ids is a no-op', () => {
    const repo = createMemoryRepo(db);
    const row = repo.create({ scope: 'global', value: 'x', source: 'manual' });
    expect(() => repo.bumpLastUsed([], Date.now())).not.toThrow();
    expect(repo.get(row.id)!.last_used_at).toBeNull();
  });

  it('setPinned flips the flag and reports whether a row was touched', () => {
    const repo = createMemoryRepo(db);
    const row = repo.create({ scope: 'global', value: 'v', source: 'manual' });
    expect(repo.setPinned(row.id, true)).toBe(true);
    expect(repo.get(row.id)!.pinned).toBe(1);
    expect(repo.setPinned(row.id, false)).toBe(true);
    expect(repo.get(row.id)!.pinned).toBe(0);
    // Unknown id -> no changes -> false.
    expect(repo.setPinned(999_999, true)).toBe(false);
  });

  it('MemoryManager.snapshot() bumps last_used_at for returned entries', () => {
    const repo = createMemoryRepo(db);
    let clock = 1_700_000_000_000;
    const mgr = createMemoryManager({ repo, logger, now: () => clock });

    const a = repo.create({ scope: 'global', value: 'a', source: 'manual' });
    const b = repo.create({ scope: 'user:42', value: 'b', source: 'manual' });

    clock = 1_700_000_005_000;
    mgr.snapshot({ principalUserId: 42, chatId: null, activeSkills: [] });

    expect(repo.get(a.id)!.last_used_at).toBe(clock);
    expect(repo.get(b.id)!.last_used_at).toBe(clock);
  });

  it('snapshot() only bumps entries that actually fit within maxEntries', () => {
    const repo = createMemoryRepo(db);
    let clock = 1_000_000_000_000;
    const mgr = createMemoryManager({ repo, logger, now: () => clock });

    // Three rows in global; snapshot(maxEntries=2) must bump exactly 2.
    // We don't assert *which* two — `listActive` orders by updated_at
    // DESC and those may tie on a fast in-memory DB.
    repo.create({ scope: 'global', value: 'a', source: 'manual' });
    repo.create({ scope: 'global', value: 'b', source: 'manual' });
    repo.create({ scope: 'global', value: 'c', source: 'manual' });

    clock = 1_000_000_010_000;
    const snap = mgr.snapshot(
      { principalUserId: null, chatId: null, activeSkills: [] },
      2,
    );
    expect(snap.entries).toHaveLength(2);

    const allRows = repo.list({ scope: 'global', limit: 10 });
    const bumped = allRows.filter((r) => r.last_used_at === clock);
    const notBumped = allRows.filter((r) => r.last_used_at === null);
    expect(bumped).toHaveLength(2);
    expect(notBumped).toHaveLength(1);
  });
});
