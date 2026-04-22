import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';
import { createMemoryRepo } from '../../src/db/repositories/memory.js';
import { createSchedulesRepo } from '../../src/db/repositories/schedules.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0001_init.sql'), 'utf8'),
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0002_memory_proposals_skill_state.sql'),
      'utf8',
    ),
  );
  return db;
}

/**
 * The three repos with dynamic-SQL `update()` methods interpolate
 * `Object.keys(patch)` directly into the SET clause. TypeScript enforces
 * the key set at compile time, but to defend against a future untyped
 * caller (or a type-cast escape hatch), each repo now filters keys through
 * an allowlist at runtime. These tests lock in that behavior — they call
 * `update()` with a deliberately invalid key cast as `unknown as ...`, and
 * assert the bad key never reaches SQL.
 */
describe('repo update() allowlist — defense-in-depth', () => {
  it('sessions.update ignores keys not in the allowlist', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    repo.create({
      id: 's1',
      source: 'dm',
      source_ref: 'c1',
      status: 'running',
      input_preview: 'x',
      model: 'm',
    });

    // Inject a malicious key that looks like a SQL fragment. The outer
    // `as unknown as` cast is how a real untyped caller would bypass TS.
    const bad = {
      status: 'completed',
      'tokens_input = 0; DROP TABLE sessions; --': 1,
    } as unknown as Parameters<typeof repo.update>[1];
    expect(() => repo.update('s1', bad)).not.toThrow();

    // Legitimate column updated; malicious one ignored.
    const row = repo.get('s1');
    expect(row?.status).toBe('completed');

    // sessions table still exists and has our row.
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it('memory.update ignores disallowed keys', () => {
    const db = makeDb();
    const repo = createMemoryRepo(db);
    const entry = repo.create({ scope: 'global', value: 'hi', source: 'manual' });

    const bad = {
      value: 'updated',
      'key = lol; DELETE FROM memory; --': 'x',
    } as unknown as Parameters<typeof repo.update>[1];
    expect(() => repo.update(entry.id, bad)).not.toThrow();

    const fresh = repo.get(entry.id)!;
    expect(fresh.value).toBe('updated');

    // Other rows still there (we only had one).
    const all = repo.list();
    expect(all).toHaveLength(1);
  });

  it('schedules.update ignores disallowed keys', () => {
    const db = makeDb();
    const repo = createSchedulesRepo(db);
    const s = repo.create({
      name: 'test',
      cron_expr: '* * * * *',
      kind: 'reminder',
      payload: '{"text":"x"}',
    });

    const bad = {
      cron_expr: '0 9 * * *',
      'payload = ""; DROP TABLE schedules; --': 'x',
    } as unknown as Parameters<typeof repo.update>[1];
    expect(() => repo.update(s.id, bad)).not.toThrow();

    const fresh = repo.get(s.id)!;
    expect(fresh.cron_expr).toBe('0 9 * * *');
    // payload NOT wiped, table NOT dropped.
    expect(fresh.payload).toBe('{"text":"x"}');
  });
});
