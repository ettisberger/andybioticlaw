import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';

/**
 * Integration test for the migration runner: a fresh DB must end up with
 * every table the current code expects, and the version number must
 * reflect every applied migration.
 */
describe('migration runner — fresh boot', () => {
  it('applies all migrations and ends at the current version', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'andy-mig-'));
    const dbPath = resolve(dir, 'test.db');
    const logger = pino({ level: 'silent' });
    try {
      const { db, close } = openDatabase(dbPath, logger);

      // Expected tables per the current migration set (0001..0009).
      const tables = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      const expected = [
        'audit',
        'budget_state',
        'heartbeats',
        'memory',
        'memory_proposals',
        'messages',
        'notes',
        'pending_email_sends',
        'schedule_runs',
        'schedules',
        'schema_version',
        'sessions',
        'skill_state',
      ];
      for (const t of expected) expect(tables).toContain(t);

      // The `recurring` column was added by migration 0004.
      const scheduleCols = db
        .prepare<[], { name: string }>(`PRAGMA table_info(schedules)`)
        .all()
        .map((r) => r.name);
      expect(scheduleCols).toContain('recurring');

      // Migration 0005 seeds exactly one row with a null anchor.
      const budgetRows = db
        .prepare<[], { id: number; daily_reset_anchor_ms: number | null }>(
          'SELECT id, daily_reset_anchor_ms FROM budget_state',
        )
        .all();
      expect(budgetRows).toEqual([{ id: 1, daily_reset_anchor_ms: null }]);

      // Migration 0007 added the `last_used_at` + `pinned` columns on memory.
      const memoryCols = db
        .prepare<[], { name: string }>(`PRAGMA table_info(memory)`)
        .all()
        .map((r) => r.name);
      expect(memoryCols).toContain('last_used_at');
      expect(memoryCols).toContain('pinned');

      // Migration 0008 added the `notes` table + `notes_fts` virtual table.
      const noteCols = db
        .prepare<[], { name: string }>(`PRAGMA table_info(notes)`)
        .all()
        .map((r) => r.name);
      for (const c of ['id', 'title', 'body', 'tags', 'source', 'pinned', 'archived']) {
        expect(noteCols).toContain(c);
      }
      // notes_fts is a virtual table — confirm it exists in sqlite_master.
      const ftsExists = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'`,
        )
        .get();
      expect(ftsExists?.name).toBe('notes_fts');

      // The runner recorded one row per applied migration.
      const versions = db
        .prepare<[], { version: number }>('SELECT version FROM schema_version ORDER BY version')
        .all()
        .map((r) => r.version);
      // Migration 0009 added sessions.agent_id + schedules.context.
      const sessionCols = db
        .prepare<[], { name: string }>(`PRAGMA table_info(sessions)`)
        .all()
        .map((r) => r.name);
      expect(sessionCols).toContain('agent_id');
      const scheduleCols2 = db
        .prepare<[], { name: string }>(`PRAGMA table_info(schedules)`)
        .all()
        .map((r) => r.name);
      expect(scheduleCols2).toContain('context');

      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-opening the same DB adds no duplicate version rows', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'andy-mig-idem-'));
    const dbPath = resolve(dir, 'test.db');
    const logger = pino({ level: 'silent' });
    try {
      const first = openDatabase(dbPath, logger);
      first.close();
      const second = openDatabase(dbPath, logger);
      const rows = second.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_version')
        .all();
      expect(rows[0]!.n).toBe(11);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
