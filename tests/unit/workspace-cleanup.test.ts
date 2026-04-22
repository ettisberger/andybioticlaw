import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';
import { sweepSessionWorkspaces } from '../../src/observability/workspace-cleanup.js';

const logger = pino({ level: 'silent' });

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

describe('sweepSessionWorkspaces', () => {
  let workspaceRoot: string;
  beforeEach(() => {
    workspaceRoot = mkdtempSync(resolve(tmpdir(), 'andy-ws-'));
  });
  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeDir(id: string, ageMs: number) {
    const path = resolve(workspaceRoot, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(resolve(path, '.mcp.json'), '{}');
    const now = Date.now();
    const pastSec = (now - ageMs) / 1000;
    utimesSync(path, pastSec, pastSec);
    return path;
  }

  it('removes dirs whose session is in a terminal state and older than minAge', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    const oldFailedId = randomUUID();
    const oldCompletedId = randomUUID();
    repo.create({
      id: oldFailedId,
      source: 'dm',
      source_ref: 'c',
      status: 'failed',
      input_preview: 'x',
      model: 'm',
    });
    repo.create({
      id: oldCompletedId,
      source: 'dm',
      source_ref: 'c',
      status: 'completed',
      input_preview: 'y',
      model: 'm',
    });
    makeDir(oldFailedId, 48 * 3600 * 1000);
    makeDir(oldCompletedId, 48 * 3600 * 1000);

    const out = sweepSessionWorkspaces({
      logger,
      sessionsRepo: repo,
      workspaceRoot,
    });
    expect(out.removed).toBe(2);
    expect(out.skipped).toBe(0);
  });

  it('keeps young dirs regardless of session state', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    const id = randomUUID();
    repo.create({
      id,
      source: 'dm',
      source_ref: 'c',
      status: 'completed',
      input_preview: 'x',
      model: 'm',
    });
    makeDir(id, 2 * 3600 * 1000); // 2h old — below default 24h threshold

    const out = sweepSessionWorkspaces({
      logger,
      sessionsRepo: repo,
      workspaceRoot,
    });
    expect(out.removed).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('keeps old dirs whose session is still running or queued', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    const runningId = randomUUID();
    const queuedId = randomUUID();
    repo.create({
      id: runningId,
      source: 'dm',
      source_ref: 'c',
      status: 'running',
      input_preview: 'x',
      model: 'm',
    });
    repo.create({
      id: queuedId,
      source: 'dm',
      source_ref: 'c',
      status: 'queued',
      input_preview: 'y',
      model: 'm',
    });
    makeDir(runningId, 48 * 3600 * 1000);
    makeDir(queuedId, 48 * 3600 * 1000);

    const out = sweepSessionWorkspaces({
      logger,
      sessionsRepo: repo,
      workspaceRoot,
    });
    expect(out.removed).toBe(0);
    expect(out.skipped).toBe(2);
  });

  it('removes dirs whose session row has been pruned from the DB', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    const orphanId = randomUUID();
    // No session row created — simulating DB retention-pruning.
    makeDir(orphanId, 48 * 3600 * 1000);

    const out = sweepSessionWorkspaces({
      logger,
      sessionsRepo: repo,
      workspaceRoot,
    });
    expect(out.removed).toBe(1);
  });

  it('ignores non-UUID directories (not ours)', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);
    const path = resolve(workspaceRoot, 'not-a-uuid');
    mkdirSync(path);
    utimesSync(path, (Date.now() - 48 * 3600 * 1000) / 1000, (Date.now() - 48 * 3600 * 1000) / 1000);

    const out = sweepSessionWorkspaces({
      logger,
      sessionsRepo: repo,
      workspaceRoot,
    });
    expect(out.scanned).toBe(0);
    expect(out.removed).toBe(0);
  });
});
