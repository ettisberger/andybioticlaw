import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { createMemoryRepo } from '../../src/db/repositories/memory.js';
import { createMemoryManager } from '../../src/memory/manager.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0001_init.sql'),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      resolve(
        __dirname,
        '..',
        '..',
        'src',
        'db',
        'migrations',
        '0002_memory_proposals_skill_state.sql',
      ),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0007_memory_hygiene.sql'),
      'utf8',
    ),
  );
  return db;
}

describe('MemoryManager', () => {
  let db: ReturnType<typeof makeDb>;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    db = makeDb();
  });

  it('resolveActiveScopes unions canonical scopes', () => {
    const mgr = createMemoryManager({ repo: createMemoryRepo(db), logger });
    const scopes = mgr.resolveActiveScopes({
      principalUserId: 42,
      chatId: '99',
      activeSkills: ['calendar', 'notion'],
    });
    expect(new Set(scopes)).toEqual(
      new Set(['global', 'user:42', 'chat:99', 'skill:calendar', 'skill:notion']),
    );
  });

  it('omits user/chat scopes when principalUserId/chatId is null', () => {
    const mgr = createMemoryManager({ repo: createMemoryRepo(db), logger });
    const scopes = mgr.resolveActiveScopes({
      principalUserId: null,
      chatId: null,
      activeSkills: [],
    });
    expect(scopes).toEqual(['global']);
  });

  it('snapshot returns only entries matching active scopes', () => {
    const repo = createMemoryRepo(db);
    const mgr = createMemoryManager({ repo, logger });
    repo.create({ scope: 'global', value: 'always', source: 'manual' });
    repo.create({ scope: 'user:42', value: 'user 42 only', source: 'manual' });
    repo.create({ scope: 'user:99', value: 'other user', source: 'manual' });
    repo.create({ scope: 'chat:abc', value: 'chat only', source: 'manual' });
    const snap = mgr.snapshot({ principalUserId: 42, chatId: 'abc', activeSkills: [] });
    const values = snap.entries.map((e) => e.value).sort();
    expect(values).toEqual(['always', 'chat only', 'user 42 only']);
  });

  it('ttl filter excludes expired entries from active snapshot', () => {
    const repo = createMemoryRepo(db);
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;
    repo.create({ scope: 'global', value: 'expired', source: 'manual', ttl_at: past });
    repo.create({ scope: 'global', value: 'live', source: 'manual', ttl_at: future });
    repo.create({ scope: 'global', value: 'no ttl', source: 'manual' });
    const mgr = createMemoryManager({ repo, logger });
    const values = mgr
      .snapshot({ principalUserId: null, chatId: null, activeSkills: [] })
      .entries.map((e) => e.value)
      .sort();
    expect(values).toEqual(['live', 'no ttl']);
  });

  it('runTtlCleanup removes expired rows', () => {
    const repo = createMemoryRepo(db);
    repo.create({ scope: 'global', value: 'gone', source: 'manual', ttl_at: Date.now() - 1 });
    repo.create({ scope: 'global', value: 'stay', source: 'manual' });
    const mgr = createMemoryManager({ repo, logger });
    expect(mgr.runTtlCleanup()).toBe(1);
    expect(repo.list()).toHaveLength(1);
  });

  it('validateScope rejects malformed input', () => {
    const mgr = createMemoryManager({ repo: createMemoryRepo(db), logger });
    expect(mgr.validateScope('global').ok).toBe(true);
    expect(mgr.validateScope('user:42').ok).toBe(true);
    expect(mgr.validateScope('chat:abc-123').ok).toBe(true);
    expect(mgr.validateScope('skill:calendar').ok).toBe(true);
    expect(mgr.validateScope('').ok).toBe(false);
    expect(mgr.validateScope('no spaces allowed').ok).toBe(false);
  });

  it('addManual sets TTL from ttlSeconds', () => {
    const repo = createMemoryRepo(db);
    const mgr = createMemoryManager({ repo, logger, now: () => 1_000_000_000 });
    const entry = mgr.addManual({ scope: 'global', value: 'v', ttlSeconds: 60 });
    expect(entry.ttl_at).toBe(1_000_000_000 + 60_000);
  });

  it('addManual rejects empty value and bad scope', () => {
    const mgr = createMemoryManager({ repo: createMemoryRepo(db), logger });
    expect(() => mgr.addManual({ scope: 'global', value: '' })).toThrow();
    expect(() => mgr.addManual({ scope: 'has spaces', value: 'v' })).toThrow();
  });
});
