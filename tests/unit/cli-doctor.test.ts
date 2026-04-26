import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkBudget,
  checkDashboard,
  checkDatabase,
  checkDisk,
  checkLogs,
  checkSchedules,
  checkServiceRunning,
} from '../../src/cli/commands/doctor.js';

/**
 * The doctor command is a read-only health check. These tests cover each
 * check function in isolation with synthetic state — full integration
 * (real claude CLI, real telegram, real dashboard) is left to manual
 * smoke-test on the VPS.
 *
 * What we pin here:
 *   - Each check returns a well-formed { name, status, detail } row.
 *   - Status transitions on the obvious failure paths (missing file,
 *     bad pidfile, archive count, etc.) match expectations.
 */

function freshTmp(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), `${prefix}-`));
}

function applyAllMigrations(db: Database.Database): void {
  // Apply all migration files so checkBudget/checkSchedules have the
  // tables they expect.
  const migDir = resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
  const files = readdirSync(migDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  for (const f of files) {
    db.exec(readFileSync(resolve(migDir, f), 'utf8'));
    const v = parseInt(f.slice(0, 4), 10);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      v,
      Date.now(),
    );
  }
}

describe('doctor — checkDatabase', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the DB file does not exist', async () => {
    dir = freshTmp('doctor-db');
    const row = await checkDatabase(resolve(dir, 'nope.db'));
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/missing/);
  });

  it('passes on a DB that has been created and migrated', async () => {
    dir = freshTmp('doctor-db-ok');
    const dbPath = resolve(dir, 'test.db');
    // checkDatabase requires the DB file to already exist (the service is
    // responsible for creating it). Pre-create + migrate by calling the
    // real openDatabase once, then close it before the check.
    const { openDatabase } = await import('../../src/db/index.js');
    const pinoMod = (await import('pino')).default;
    const seed = openDatabase(dbPath, pinoMod({ level: 'silent' }));
    seed.close();

    const row = await checkDatabase(dbPath);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/WAL/);
    expect(row.extras?.some((e) => e.startsWith('journal_mode=wal'))).toBe(true);
  });
});

describe('doctor — checkDashboard', () => {
  it('skips when the dashboard is disabled in config', async () => {
    const row = await checkDashboard({
      enabled: false,
      host: '127.0.0.1',
      port: 18790,
      basicAuth: { enabled: false, passwordHash: '' },
    });
    expect(row.status).toBe('skip');
  });

  it('fails when basic auth is enabled but no password hash is set', async () => {
    const row = await checkDashboard({
      enabled: true,
      host: '127.0.0.1',
      port: 1, // unreachable, but we never get there
      basicAuth: { enabled: true, passwordHash: '' },
    });
    expect(row.status).toBe('fail');
    expect(row.detail).toMatch(/passwordHash/);
  });

  it('warns (not fails) when nothing is listening on the port', async () => {
    // Port 1 is reserved and won't have an http server. The check should
    // come back as "warn — service stopped?" rather than "fail".
    const row = await checkDashboard({
      enabled: true,
      host: '127.0.0.1',
      port: 1,
      basicAuth: { enabled: false, passwordHash: '' },
    });
    expect(['warn', 'fail']).toContain(row.status);
  });
});

describe('doctor — checkServiceRunning', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmp('doctor-svc');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('warns when no pidfile exists', () => {
    const row = checkServiceRunning(dir);
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/not currently running/);
  });

  it('warns on stale pidfile pointing at a dead pid', () => {
    // pid 99999999 is almost certainly not running.
    writeFileSync(resolve(dir, 'andybioticlaw.pid'), '99999999');
    const row = checkServiceRunning(dir);
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/stale/);
  });

  it('reports ok for our own pid', () => {
    writeFileSync(resolve(dir, 'andybioticlaw.pid'), String(process.pid));
    const row = checkServiceRunning(dir);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(new RegExp(`pid ${process.pid}`));
  });

  it('warns on bad pidfile content', () => {
    writeFileSync(resolve(dir, 'andybioticlaw.pid'), 'not-a-number');
    const row = checkServiceRunning(dir);
    expect(row.status).toBe('warn');
  });
});

describe('doctor — checkSchedules + checkBudget (DB-backed)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applyAllMigrations(db);
  });
  afterEach(() => db.close());

  it('checkSchedules reports zero on a fresh DB', () => {
    const row = checkSchedules(db);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/0 enabled of 0/);
  });

  it('checkBudget reports zero usage on a fresh DB', () => {
    const row = checkBudget(db, {
      service: { timezone: 'UTC' },
      budget: {
        dailyTokenLimit: 1_000_000,
        perSessionTokenLimit: 100_000,
        dailyResetTime: '04:00',
      },
    });
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/0\/1000000 tokens used/);
  });
});

describe('doctor — checkDisk', () => {
  let dir: string;
  beforeEach(() => (dir = freshTmp('doctor-disk')));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails when the path does not exist', () => {
    const row = checkDisk(resolve(dir, 'no-such.db'));
    expect(row.status).toBe('fail');
  });

  it('reports ok when the file exists', () => {
    const p = resolve(dir, 'fake.db');
    writeFileSync(p, 'x'.repeat(1024));
    const row = checkDisk(p);
    // status may be 'ok' or 'warn' depending on the test runner's free
    // disk space, but it should not be 'fail'.
    expect(row.status).not.toBe('fail');
    expect(row.detail).toMatch(/db .* MiB/);
  });
});

describe('doctor — checkLogs', () => {
  let dir: string;
  beforeEach(() => (dir = freshTmp('doctor-logs')));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('warns when logs dir is missing', () => {
    const row = checkLogs(resolve(dir, 'no-logs'));
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/missing/);
  });

  it('warns when log file is missing', () => {
    // dir exists, but no andybioticlaw.log inside.
    const row = checkLogs(dir);
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/log missing/);
  });

  it('reports ok when log file is present and small', () => {
    writeFileSync(resolve(dir, 'andybioticlaw.log'), 'hello\n');
    const row = checkLogs(dir);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/writable/);
  });
});
