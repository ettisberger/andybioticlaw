import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';
import { createMessagesRepo } from '../../src/db/repositories/messages.js';

/**
 * `SessionsRepo.remove` is the only path that hard-deletes a session.
 * Three things have to happen atomically:
 *   1. messages cascade away (FK ON DELETE CASCADE in 0001_init).
 *   2. memory_proposals.session_id orphans get cleaned (no FK in schema).
 *   3. pending_email_sends.{propose,commit}_session_id orphans get cleaned.
 *
 * The remove() method wraps all three in a transaction and returns the
 * counts so the dashboard can show "deleted N + M messages + ..." and the
 * audit log can record what's gone.
 */

function makeDb() {
  const db = new Database(':memory:');
  // Apply every migration so memory_proposals + pending_email_sends + skill_state
  // tables exist for the orphan cleanup paths. Without 0002+ those queries
  // would fail with "no such table".
  const migDir = resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
  const files = readdirSync(migDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(resolve(migDir, f), 'utf8'));
  }
  // FK enforcement is OFF by default in better-sqlite3; the cascade test
  // below depends on it being ON, just like the production code does.
  db.pragma('foreign_keys = ON');
  return db;
}

function seedSession(db: Database.Database, id: string) {
  const repo = createSessionsRepo(db);
  repo.create({
    id,
    source: 'dm',
    source_ref: '99',
    status: 'running',
    input_preview: 'hi',
    model: 'claude-opus-4-7',
    agent_id: 'emma',
  });
  // Sessions only become deletable from the dashboard when not running, but
  // the repo allows any status. Mark completed so the test mirrors real usage.
  repo.update(id, { status: 'completed' });
}

function seedMessage(db: Database.Database, sessionId: string) {
  const messages = createMessagesRepo(db);
  messages.insert({
    session_id: sessionId,
    chat_id: '99',
    role: 'user',
    content: 'hello',
  });
}

function seedMemoryProposal(db: Database.Database, sessionId: string) {
  db.prepare(
    `INSERT INTO memory_proposals
     (session_id, chat_id, scope, proposed_value, proposed_key, ttl_seconds, status, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?)`,
  ).run(sessionId, '99', 'user:99', 'val', Date.now());
}

function seedPendingEmailSend(
  db: Database.Database,
  proposeSessionId: string,
  commitSessionId: string | null,
) {
  // Schema for pending_email_sends is in migration 0003 — we insert the
  // minimum required fields. Some columns are nullable; the orphan cleanup
  // only cares about the session id columns.
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(pending_email_sends)`)
    .all()
    .map((r) => r.name);
  // Build a permissive INSERT that touches only the session id columns
  // we care about plus required not-null columns. If the schema evolves
  // and adds a new required column without a default, this insert fails
  // and we fix the test.
  const insert: Record<string, unknown> = {
    propose_session_id: proposeSessionId,
    commit_session_id: commitSessionId,
  };
  if (cols.includes('chat_id')) insert['chat_id'] = '99';
  if (cols.includes('to_addr')) insert['to_addr'] = 'a@b';
  if (cols.includes('subject')) insert['subject'] = 's';
  if (cols.includes('body')) insert['body'] = 'b';
  if (cols.includes('status')) insert['status'] = 'pending';
  if (cols.includes('created_at')) insert['created_at'] = Date.now();
  if (cols.includes('proposed_at')) insert['proposed_at'] = Date.now();
  const keys = Object.keys(insert);
  const placeholders = keys.map((k) => `@${k}`).join(', ');
  db.prepare(
    `INSERT INTO pending_email_sends (${keys.join(', ')}) VALUES (${placeholders})`,
  ).run(insert);
}

describe('SessionsRepo.remove', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns zeroes when the session does not exist', () => {
    const repo = createSessionsRepo(db);
    const r = repo.remove('does-not-exist');
    expect(r.session).toBe(0);
    expect(r.messages).toBe(0);
    expect(r.proposals).toBe(0);
    expect(r.emailSends).toBe(0);
  });

  it('deletes the session row and reports the count', () => {
    seedSession(db, 's1');
    const repo = createSessionsRepo(db);
    const r = repo.remove('s1');
    expect(r.session).toBe(1);
    expect(repo.get('s1')).toBeNull();
  });

  it('cascades messages via FK and reports the count', () => {
    seedSession(db, 's1');
    seedMessage(db, 's1');
    seedMessage(db, 's1');
    seedMessage(db, 's1');

    const repo = createSessionsRepo(db);
    const r = repo.remove('s1');
    expect(r.messages).toBe(3);
    const remaining = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM messages`)
      .get()!.n;
    expect(remaining).toBe(0);
  });

  it('cleans memory_proposals orphans (no FK in schema)', () => {
    seedSession(db, 's1');
    seedMemoryProposal(db, 's1');
    seedMemoryProposal(db, 's1');

    const repo = createSessionsRepo(db);
    const r = repo.remove('s1');
    expect(r.proposals).toBe(2);
    const remaining = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM memory_proposals`)
      .get()!.n;
    expect(remaining).toBe(0);
  });

  it('cleans pending_email_sends matching either propose_ or commit_session_id', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    // Row 1: s1 proposed it, s2 committed it.
    seedPendingEmailSend(db, 's1', 's2');
    // Row 2: s1 only proposed.
    seedPendingEmailSend(db, 's1', null);
    // Row 3: unrelated session — should survive.
    seedSession(db, 'sX');
    seedPendingEmailSend(db, 'sX', null);

    const repo = createSessionsRepo(db);
    const r = repo.remove('s1');
    // Both pending rows referencing s1 (propose) or s1 (commit) wiped.
    expect(r.emailSends).toBe(2);
    const survivors = db
      .prepare<[], { propose_session_id: string }>(
        `SELECT propose_session_id FROM pending_email_sends`,
      )
      .all();
    expect(survivors).toEqual([{ propose_session_id: 'sX' }]);
  });

  it('does not touch other sessions or unrelated rows', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    seedMessage(db, 's2');
    seedMemoryProposal(db, 's2');

    const repo = createSessionsRepo(db);
    repo.remove('s1');

    expect(repo.get('s2')).not.toBeNull();
    const msgs = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM messages`)
      .get()!.n;
    expect(msgs).toBe(1);
    const proposals = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM memory_proposals`)
      .get()!.n;
    expect(proposals).toBe(1);
  });
});
