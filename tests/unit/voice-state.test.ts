import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createVoiceStateRepo } from '../../src/db/repositories/voice-state.js';

function makeInMemoryDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE voice_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO voice_state (id, enabled, updated_at) VALUES (1, 0, 1000);
  `);
  return db;
}

describe('VoiceStateRepo', () => {
  it('defaults to disabled on a fresh DB', () => {
    const repo = createVoiceStateRepo(makeInMemoryDb());
    expect(repo.getEnabled()).toBe(false);
  });

  it('persists enable/disable toggles and bumps updated_at', () => {
    const db = makeInMemoryDb();
    const repo = createVoiceStateRepo(db);
    const now = 2_000_000;
    repo.setEnabled(true, now);
    expect(repo.getEnabled()).toBe(true);
    expect(repo.getUpdatedAt()).toBe(now);

    const later = 3_000_000;
    repo.setEnabled(false, later);
    expect(repo.getEnabled()).toBe(false);
    expect(repo.getUpdatedAt()).toBe(later);
  });

  it('uses Date.now() when no explicit timestamp is passed', () => {
    const before = Date.now();
    const repo = createVoiceStateRepo(makeInMemoryDb());
    repo.setEnabled(true);
    const stamp = repo.getUpdatedAt();
    const after = Date.now();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });
});
