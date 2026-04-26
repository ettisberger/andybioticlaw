import type { Database } from 'better-sqlite3';

export type NoteSource = 'telegram' | 'voice' | 'dashboard' | 'agent';

export interface NoteRecord {
  id: number;
  user_id: number | null;
  title: string | null;
  body: string;
  /** JSON-encoded array of strings as stored in SQLite. */
  tags: string;
  source: NoteSource;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface CreateNoteInput {
  body: string;
  title?: string | null;
  tags?: string[];
  source: NoteSource;
  userId?: number | null;
}

export interface UpdateNotePatch {
  body?: string;
  title?: string | null;
  tags?: string[];
}

export interface ListNotesOptions {
  /** FTS5 query string. When set, results are ranked by bm25 instead of recency. */
  query?: string;
  /** Restrict to notes whose `tags` JSON array contains this string. */
  tag?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotesRepo {
  create(input: CreateNoteInput): NoteRecord;
  get(id: number): NoteRecord | null;
  list(opts?: ListNotesOptions): NoteRecord[];
  update(id: number, patch: UpdateNotePatch): NoteRecord | null;
  setPinned(id: number, pinned: boolean): boolean;
  setArchived(id: number, archived: boolean): boolean;
  hardDelete(id: number): boolean;
  count(opts?: { includeArchived?: boolean }): number;
}

/**
 * FTS5 reserves a small set of characters that would otherwise blow up the
 * MATCH parser (`"`, `*`, parentheses, `:`, `-` at token start, etc). The
 * search box on the dashboard takes free-form input, so we wrap the whole
 * query in double-quotes and escape internal quotes — that turns it into a
 * single phrase query, which is what users almost always mean anyway.
 */
function quoteFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

export function createNotesRepo(db: Database): NotesRepo {
  const insertNote = db.prepare(
    `INSERT INTO notes (user_id, title, body, tags, source, created_at, updated_at)
     VALUES (@user_id, @title, @body, @tags, @source, @created_at, @updated_at)`,
  );

  const selectById = db.prepare<{ id: number }, NoteRecord>(
    `SELECT * FROM notes WHERE id = @id`,
  );

  const deleteById = db.prepare<{ id: number }>(`DELETE FROM notes WHERE id = @id`);

  const setPinnedStmt = db.prepare<{ id: number; pinned: number; updated_at: number }>(
    `UPDATE notes SET pinned = @pinned, updated_at = @updated_at WHERE id = @id`,
  );

  const setArchivedStmt = db.prepare<{
    id: number;
    archived: number;
    updated_at: number;
  }>(
    `UPDATE notes SET archived = @archived, updated_at = @updated_at WHERE id = @id`,
  );

  const countAll = db.prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM notes`,
  );
  const countActive = db.prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM notes WHERE archived = 0`,
  );

  return {
    create(input) {
      const now = Date.now();
      const result = insertNote.run({
        user_id: input.userId ?? null,
        title: input.title ?? null,
        body: input.body,
        tags: JSON.stringify(input.tags ?? []),
        source: input.source,
        created_at: now,
        updated_at: now,
      });
      const row = selectById.get({ id: Number(result.lastInsertRowid) });
      if (!row) throw new Error('note insert succeeded but row not found — impossible');
      return row;
    },

    get(id) {
      return selectById.get({ id }) ?? null;
    },

    list({ query, tag, includeArchived = false, limit = 100, offset = 0 } = {}) {
      const params: Record<string, unknown> = { limit, offset };
      const where: string[] = [];
      if (!includeArchived) where.push('n.archived = 0');
      if (tag) {
        where.push(`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = @tag)`);
        params['tag'] = tag;
      }

      let sql: string;
      if (query && query.trim() !== '') {
        params['q'] = quoteFtsQuery(query.trim());
        // Join on FTS5 first (smallest result set), then apply other filters.
        const whereClause = where.length ? `AND ${where.join(' AND ')}` : '';
        sql = `
          SELECT n.* FROM notes n
          JOIN notes_fts f ON f.rowid = n.id
          WHERE notes_fts MATCH @q ${whereClause}
          ORDER BY n.pinned DESC, bm25(notes_fts), n.updated_at DESC
          LIMIT @limit OFFSET @offset
        `;
      } else {
        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        sql = `
          SELECT n.* FROM notes n
          ${whereClause}
          ORDER BY n.pinned DESC, n.updated_at DESC
          LIMIT @limit OFFSET @offset
        `;
      }
      return db.prepare<Record<string, unknown>, NoteRecord>(sql).all(params);
    },

    update(id, patch) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id, updated_at: Date.now() };
      if (patch.body !== undefined) {
        sets.push('body = @body');
        params['body'] = patch.body;
      }
      if (patch.title !== undefined) {
        sets.push('title = @title');
        params['title'] = patch.title;
      }
      if (patch.tags !== undefined) {
        sets.push('tags = @tags');
        params['tags'] = JSON.stringify(patch.tags);
      }
      if (sets.length === 0) return selectById.get({ id }) ?? null;
      sets.push('updated_at = @updated_at');
      const result = db
        .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = @id`)
        .run(params);
      if (result.changes === 0) return null;
      return selectById.get({ id }) ?? null;
    },

    setPinned(id, pinned) {
      const r = setPinnedStmt.run({
        id,
        pinned: pinned ? 1 : 0,
        updated_at: Date.now(),
      });
      return r.changes > 0;
    },

    setArchived(id, archived) {
      const r = setArchivedStmt.run({
        id,
        archived: archived ? 1 : 0,
        updated_at: Date.now(),
      });
      return r.changes > 0;
    },

    hardDelete(id) {
      return deleteById.run({ id }).changes > 0;
    },

    count({ includeArchived = false } = {}) {
      const row = (includeArchived ? countAll : countActive).get();
      return row?.n ?? 0;
    },
  };
}
