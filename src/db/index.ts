import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

export interface DbHandle {
  db: Db;
  close: () => void;
}

/**
 * Opens (and, on first run, initializes) the SQLite DB at `dbPath`. Runs any
 * pending migrations from `migrationsDir` based on the `schema_version` table.
 *
 * WAL mode is enabled for durability + concurrent readers (dashboard) while a
 * writer (main service) is active. File permissions are tightened to 0600 to
 * match the spec's secrets posture.
 */
export function openDatabase(
  dbPath: string,
  logger: Logger,
  migrationsDirOverride?: string,
): DbHandle {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // non-fatal: on some platforms (CI, shared volumes) chmod is denied.
  }

  const migrationsDir = migrationsDirOverride ?? defaultMigrationsDir();
  runMigrations(db, migrationsDir, logger);

  return {
    db,
    close: () => db.close(),
  };
}

function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'migrations');
}

function ensureSchemaVersionTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
}

function currentSchemaVersion(db: Db): number {
  const row = db
    .prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_version')
    .get();
  return row?.v ?? 0;
}

function runMigrations(db: Db, dir: string, logger: Logger): void {
  ensureSchemaVersionTable(db);
  const have = currentSchemaVersion(db);

  if (!existsSync(dir)) {
    logger.warn({ dir }, 'no migrations directory — skipping');
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  const applyMigration = db.transaction((file: string) => {
    const version = parseInt(file.slice(0, 4), 10);
    const sql = readFileSync(resolve(dir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      version,
      Date.now(),
    );
  });

  let applied = 0;
  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    if (Number.isNaN(version) || version <= have) continue;
    applyMigration(file);
    logger.info({ file, version }, 'applied migration');
    applied += 1;
  }
  if (applied === 0) logger.debug({ version: have }, 'db schema is up to date');
}
