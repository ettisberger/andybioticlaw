import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNotesRepo, type NotesRepo } from '../../src/db/repositories/notes.js';

/**
 * NotesRepo end-to-end: CRUD, FTS5 search round-trip, tag filter,
 * archive/pin lifecycle, ordering. The repo is the single source of
 * truth for both the dashboard route and the MCP server, so any
 * regression here affects both surfaces.
 */

function makeDb() {
  const db = new Database(':memory:');
  // Only need the notes migration. notes_fts and triggers are self-contained
  // — no FK to anything in earlier migrations.
  db.exec(
    readFileSync(
      resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0008_notes.sql'),
      'utf8',
    ),
  );
  return db;
}

describe('NotesRepo', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: NotesRepo;

  beforeEach(() => {
    db = makeDb();
    repo = createNotesRepo(db);
  });

  it('creates a note and reads it back', () => {
    const created = repo.create({
      body: 'pick up Sarah at 5pm',
      title: 'Sarah pickup',
      tags: ['family', 'today'],
      source: 'agent',
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.body).toBe('pick up Sarah at 5pm');
    expect(created.title).toBe('Sarah pickup');
    expect(JSON.parse(created.tags)).toEqual(['family', 'today']);
    expect(created.source).toBe('agent');
    expect(created.archived).toBe(0);
    expect(created.pinned).toBe(0);

    const fetched = repo.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.body).toBe('pick up Sarah at 5pm');
  });

  it('lists notes newest-first (pinned float to top)', async () => {
    // Date.now() resolution is millisecond — without a small gap, the three
    // create()s share an updated_at and the unpinned-tiebreak order isn't
    // deterministic. Sleep a tick between writes so the ordering assertion
    // tests what we actually care about (pinned-first, then DESC by time).
    const a = repo.create({ body: 'a', source: 'dashboard' });
    await new Promise((r) => setTimeout(r, 2));
    const b = repo.create({ body: 'b', source: 'dashboard' });
    await new Promise((r) => setTimeout(r, 2));
    const c = repo.create({ body: 'c', source: 'dashboard' });
    repo.setPinned(a.id, true);
    const list = repo.list();
    expect(list.map((n) => n.id)).toEqual([a.id, c.id, b.id]);
  });

  it('FTS5 search ranks matches and ignores irrelevant rows', () => {
    repo.create({ body: 'tax filing deadline is April 15', source: 'agent' });
    repo.create({ body: 'grocery list: milk eggs bread', source: 'agent' });
    repo.create({ body: 'mortgage and tax refund both arrive monthly', source: 'agent' });

    const hits = repo.list({ query: 'tax' });
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.body).toMatch(/tax/);
    }
  });

  it('FTS5 search tolerates user input with FTS-syntax characters', () => {
    repo.create({ body: 'doctor visit (annual checkup)', source: 'dashboard' });
    repo.create({ body: 'unrelated note', source: 'dashboard' });
    // Parens and quotes would otherwise blow up FTS5's MATCH parser; the
    // repo wraps the query as a phrase so this stays safe.
    expect(() => repo.list({ query: 'doctor (annual)' })).not.toThrow();
    expect(() => repo.list({ query: 'with "quotes"' })).not.toThrow();
  });

  it('tag filter restricts to notes carrying the tag', () => {
    repo.create({ body: 'a', tags: ['work', 'urgent'], source: 'dashboard' });
    repo.create({ body: 'b', tags: ['personal'], source: 'dashboard' });
    repo.create({ body: 'c', tags: ['work'], source: 'dashboard' });

    const work = repo.list({ tag: 'work' });
    expect(work.length).toBe(2);
    expect(work.every((n) => JSON.parse(n.tags).includes('work'))).toBe(true);
  });

  it('updates body, title, and tags; bumps updated_at', async () => {
    const n = repo.create({ body: 'old', title: 'old title', source: 'dashboard' });
    // Sleep a millisecond so updated_at can actually move forward — Date.now()
    // resolution is millisecond and a synchronous update inside the same tick
    // would otherwise produce identical timestamps.
    await new Promise((r) => setTimeout(r, 2));
    const updated = repo.update(n.id, { body: 'new', tags: ['x'] });
    expect(updated).not.toBeNull();
    expect(updated!.body).toBe('new');
    expect(updated!.title).toBe('old title'); // unchanged
    expect(JSON.parse(updated!.tags)).toEqual(['x']);
    expect(updated!.updated_at).toBeGreaterThan(n.updated_at);
  });

  it('FTS5 sync trigger updates the index on body changes', () => {
    const n = repo.create({ body: 'original content', source: 'dashboard' });
    expect(repo.list({ query: 'original' }).length).toBe(1);
    repo.update(n.id, { body: 'replaced wording' });
    expect(repo.list({ query: 'original' }).length).toBe(0);
    expect(repo.list({ query: 'replaced' }).length).toBe(1);
  });

  it('archive hides from default list, includeArchived restores it', () => {
    const n = repo.create({ body: 'to archive', source: 'dashboard' });
    expect(repo.list().some((r) => r.id === n.id)).toBe(true);
    repo.setArchived(n.id, true);
    expect(repo.list().some((r) => r.id === n.id)).toBe(false);
    expect(repo.list({ includeArchived: true }).some((r) => r.id === n.id)).toBe(true);
    repo.setArchived(n.id, false);
    expect(repo.list().some((r) => r.id === n.id)).toBe(true);
  });

  it('hardDelete removes the row and its FTS index entry', () => {
    const n = repo.create({ body: 'soon to vanish', source: 'dashboard' });
    expect(repo.list({ query: 'vanish' }).length).toBe(1);
    expect(repo.hardDelete(n.id)).toBe(true);
    expect(repo.get(n.id)).toBeNull();
    expect(repo.list({ query: 'vanish' }).length).toBe(0);
  });

  it('count() respects includeArchived', () => {
    repo.create({ body: 'a', source: 'dashboard' });
    const b = repo.create({ body: 'b', source: 'dashboard' });
    repo.setArchived(b.id, true);
    expect(repo.count()).toBe(1);
    expect(repo.count({ includeArchived: true })).toBe(2);
  });

  it('returns null/false on operations against a missing id', () => {
    expect(repo.get(9999)).toBeNull();
    expect(repo.update(9999, { body: 'x' })).toBeNull();
    expect(repo.setPinned(9999, true)).toBe(false);
    expect(repo.setArchived(9999, true)).toBe(false);
    expect(repo.hardDelete(9999)).toBe(false);
  });
});
