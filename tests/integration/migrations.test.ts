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

      // Expected tables per the current migration set (0001 + 0002).
      const tables = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all()
        .map((r) => r.name);
      const expected = [
        'audit',
        'heartbeats',
        'memory',
        'memory_proposals',
        'messages',
        'schedule_runs',
        'schedules',
        'schema_version',
        'sessions',
        'skill_state',
      ];
      for (const t of expected) expect(tables).toContain(t);

      // The runner recorded two rows in schema_version.
      const versions = db
        .prepare<[], { version: number }>('SELECT version FROM schema_version ORDER BY version')
        .all()
        .map((r) => r.version);
      expect(versions).toEqual([1, 2]);

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
      expect(rows[0]!.n).toBe(2);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
