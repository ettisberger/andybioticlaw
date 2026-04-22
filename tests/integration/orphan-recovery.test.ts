import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';

/**
 * Boot-time orphan sweep integration test: simulate a crashed prior run by
 * inserting sessions in `running` / `queued` state, then invoke the same
 * `markRunningAsOrphaned()` the service calls on startup and confirm both
 * the status flip and the chat-ids report.
 */
describe('orphan recovery on boot', () => {
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
    return db;
  }

  it('flips running+queued sessions to orphaned and reports their chat ids', () => {
    const db = makeDb();
    const repo = createSessionsRepo(db);

    repo.create({ id: 's-running-1', source: 'dm', source_ref: 'chat-A', status: 'running', input_preview: 'a', model: 'm' });
    repo.create({ id: 's-running-2', source: 'dm', source_ref: 'chat-A', status: 'running', input_preview: 'b', model: 'm' });
    repo.create({ id: 's-queued-1',  source: 'dm', source_ref: 'chat-B', status: 'queued',  input_preview: 'c', model: 'm' });
    repo.create({ id: 's-done-1',    source: 'dm', source_ref: 'chat-A', status: 'completed', input_preview: 'd', model: 'm' });

    const result = repo.markRunningAsOrphaned();
    expect(result.count).toBe(3);
    expect(new Set(result.chatIds)).toEqual(new Set(['chat-A', 'chat-B']));

    // Status correctly flipped.
    expect(repo.get('s-running-1')!.status).toBe('orphaned');
    expect(repo.get('s-running-2')!.status).toBe('orphaned');
    expect(repo.get('s-queued-1')!.status).toBe('orphaned');
    // Completed session untouched.
    expect(repo.get('s-done-1')!.status).toBe('completed');

    // Error column populated for orphaned rows.
    expect(repo.get('s-running-1')!.error).toContain('service restarted');

    // Sweeping a second time is a no-op (all running/queued gone).
    const second = repo.markRunningAsOrphaned();
    expect(second.count).toBe(0);
  });
});
