import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';
import { createMessagesRepo } from '../../src/db/repositories/messages.js';

function makeDb() {
  const db = new Database(':memory:');
  const sql = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0001_init.sql'),
    'utf8',
  );
  db.exec(sql);
  return db;
}

describe('SessionsRepo', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it('create → update → get round-trip', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 's1',
      source: 'dm',
      source_ref: '123456789',
      status: 'running',
      input_preview: 'hello',
      model: 'claude-opus-4-7',
    });
    repo.update('s1', { status: 'completed', tokens_input: 50, tokens_output: 20, ended_at: Date.now() });
    const r = repo.get('s1');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('completed');
    expect(r!.tokens_input).toBe(50);
    expect(r!.tokens_output).toBe(20);
  });

  it('markRunningAsOrphaned flips running+queued rows and returns chatIds', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 's1',
      source: 'dm',
      source_ref: 'c1',
      status: 'running',
      input_preview: 'a',
      model: 'm',
    });
    repo.create({
      id: 's2',
      source: 'dm',
      source_ref: 'c2',
      status: 'queued',
      input_preview: 'b',
      model: 'm',
    });
    repo.create({
      id: 's3',
      source: 'dm',
      source_ref: 'c1',
      status: 'completed',
      input_preview: 'c',
      model: 'm',
    });
    const result = repo.markRunningAsOrphaned();
    expect(result.count).toBe(2);
    expect(new Set(result.chatIds)).toEqual(new Set(['c1', 'c2']));
    expect(repo.get('s1')!.status).toBe('orphaned');
    expect(repo.get('s2')!.status).toBe('orphaned');
    expect(repo.get('s3')!.status).toBe('completed');
  });

  it('tokensUsedBetween respects window boundaries', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 's1', source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'm',
    });
    repo.update('s1', { tokens_input: 100, tokens_output: 50 });

    const now = Date.now();
    expect(repo.tokensUsedBetween(now - 60_000, now + 60_000)).toBe(150);
    expect(repo.tokensUsedBetween(now + 10_000, now + 60_000)).toBe(0);
  });

  it('dailyRaw returns only rows within the window', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 'in',
      source: 'dm',
      source_ref: 'c1',
      status: 'completed',
      input_preview: '',
      model: 'claude-opus-4-7',
    });
    repo.update('in', { tokens_input: 10, tokens_output: 5 });

    const now = Date.now();
    const rows = repo.dailyRaw(now - 60_000, now + 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(15);
    expect(rows[0]!.model).toBe('claude-opus-4-7');

    // Window that starts in the future → empty result.
    expect(repo.dailyRaw(now + 10_000, now + 60_000)).toHaveLength(0);
  });

  it('perModelTotals buckets by model, preserves null as its own bucket', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 'opus-1',
      source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'claude-opus-4-7',
    });
    repo.update('opus-1', { tokens_input: 100, tokens_output: 20 });

    repo.create({
      id: 'opus-2',
      source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'claude-opus-4-7',
    });
    repo.update('opus-2', { tokens_input: 50, tokens_output: 10 });

    repo.create({
      id: 'haiku-1',
      source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'claude-haiku-4-5',
    });
    repo.update('haiku-1', { tokens_input: 30, tokens_output: 5 });

    const totals = repo.perModelTotals(0);
    const byModel = Object.fromEntries(totals.map((t) => [t.model, t]));
    expect(byModel['claude-opus-4-7']!.tokensIn).toBe(150);
    expect(byModel['claude-opus-4-7']!.tokensOut).toBe(30);
    expect(byModel['claude-opus-4-7']!.sessions).toBe(2);
    expect(byModel['claude-haiku-4-5']!.sessions).toBe(1);
    // Descending by total tokens (opus > haiku).
    expect(totals[0]!.model).toBe('claude-opus-4-7');
  });

  it('totalsBetween returns tokens + session count as separate fields', () => {
    const repo = createSessionsRepo(db);
    repo.create({
      id: 'a',
      source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'claude-opus-4-7',
    });
    repo.update('a', { tokens_input: 100, tokens_output: 50 });
    repo.create({
      id: 'b',
      source: 'dm', source_ref: 'c1', status: 'completed',
      input_preview: '', model: 'claude-opus-4-7',
    });
    repo.update('b', { tokens_input: 10, tokens_output: 5 });

    const now = Date.now();
    const t = repo.totalsBetween(now - 60_000, now + 60_000);
    expect(t.tokensIn).toBe(110);
    expect(t.tokensOut).toBe(55);
    expect(t.sessions).toBe(2);

    // Empty window.
    const empty = repo.totalsBetween(now + 10_000, now + 60_000);
    expect(empty).toEqual({ tokensIn: 0, tokensOut: 0, sessions: 0 });
  });
});

describe('MessagesRepo', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    const sessions = createSessionsRepo(db);
    sessions.create({
      id: 's1',
      source: 'dm',
      source_ref: 'c1',
      status: 'running',
      input_preview: '',
      model: 'm',
    });
  });

  it('latestByChat returns chronological order (oldest first after reverse)', async () => {
    const repo = createMessagesRepo(db);
    repo.insert({ session_id: 's1', chat_id: 'c1', role: 'user', content: 'one' });
    await new Promise((r) => setTimeout(r, 2));
    repo.insert({ session_id: 's1', chat_id: 'c1', role: 'assistant', content: 'two' });
    await new Promise((r) => setTimeout(r, 2));
    repo.insert({ session_id: 's1', chat_id: 'c1', role: 'user', content: 'three' });

    const rows = repo.latestByChat('c1', 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe('two');
    expect(rows[1]!.content).toBe('three');
  });

  it('scoped by chat_id', () => {
    const repo = createMessagesRepo(db);
    const sessions = createSessionsRepo(db);
    sessions.create({
      id: 's2',
      source: 'dm',
      source_ref: 'c2',
      status: 'running',
      input_preview: '',
      model: 'm',
    });
    repo.insert({ session_id: 's1', chat_id: 'c1', role: 'user', content: 'a' });
    repo.insert({ session_id: 's2', chat_id: 'c2', role: 'user', content: 'b' });
    const c1 = repo.latestByChat('c1', 10);
    expect(c1).toHaveLength(1);
    expect(c1[0]!.content).toBe('a');
  });
});
