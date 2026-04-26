import type { FastifyPluginAsync } from 'fastify';
import type {
  NotesRepo,
  NoteRecord,
  ListNotesOptions,
} from '../../db/repositories/notes.js';
import type { AuditRepo } from '../../db/repositories/audit.js';

export interface NotesRoutesDeps {
  repo: NotesRepo;
  audit: AuditRepo;
}

interface NoteResponse {
  id: number;
  title: string | null;
  body: string;
  tags: string[];
  source: string;
  pinned: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
}

interface NoteListItem {
  id: number;
  title: string | null;
  snippet: string;
  tags: string[];
  source: string;
  pinned: boolean;
  archived: boolean;
  updated_at: number;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toResponse(row: NoteRecord): NoteResponse {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    source: row.source,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toListItem(row: NoteRecord): NoteListItem {
  return {
    id: row.id,
    title: row.title,
    snippet: row.body.length > 200 ? row.body.slice(0, 200) + '…' : row.body,
    tags: parseTags(row.tags),
    source: row.source,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    updated_at: row.updated_at,
  };
}

interface CreateNoteBody {
  body?: string;
  title?: string | null;
  tags?: string[];
}

interface UpdateNoteBody {
  body?: string;
  title?: string | null;
  tags?: string[];
}

interface PinBody {
  pinned?: boolean;
}

export const notesRoutes =
  (deps: NotesRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get<{
      Querystring: {
        query?: string;
        tag?: string;
        includeArchived?: string;
        limit?: string;
        offset?: string;
      };
    }>('/api/notes', async (req) => {
      const limit = req.query.limit
        ? Math.min(Math.max(Number(req.query.limit), 1), 500)
        : 100;
      const offset = req.query.offset ? Math.max(Number(req.query.offset), 0) : 0;
      const includeArchived = req.query.includeArchived === 'true';
      const opts: ListNotesOptions = {
        includeArchived,
        limit,
        offset,
      };
      if (req.query.query !== undefined) opts.query = req.query.query;
      if (req.query.tag !== undefined) opts.tag = req.query.tag;
      const rows = deps.repo.list(opts);
      return {
        notes: rows.map(toListItem),
        count: rows.length,
        total: deps.repo.count({ includeArchived }),
      };
    });

    app.get<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
      const row = deps.repo.get(Number(req.params.id));
      if (!row) {
        reply.code(404);
        return { error: 'not found' };
      }
      return toResponse(row);
    });

    app.post<{ Body: CreateNoteBody }>('/api/notes', async (req, reply) => {
      const body = req.body ?? {};
      if (!body.body || typeof body.body !== 'string' || body.body.trim() === '') {
        reply.code(400);
        return { error: 'body is required' };
      }
      const row = deps.repo.create({
        body: body.body,
        title: body.title ?? null,
        tags: Array.isArray(body.tags)
          ? body.tags.filter((t) => typeof t === 'string')
          : [],
        source: 'dashboard',
      });
      deps.audit.record({
        kind: 'note_created',
        actor: 'dashboard',
        detail: { id: row.id },
      });
      return toResponse(row);
    });

    app.patch<{ Params: { id: string }; Body: UpdateNoteBody }>(
      '/api/notes/:id',
      async (req, reply) => {
        const id = Number(req.params.id);
        const body = req.body ?? {};
        const patch: { body?: string; title?: string | null; tags?: string[] } = {};
        if (body.body !== undefined) patch.body = body.body;
        if (body.title !== undefined) patch.title = body.title;
        if (body.tags !== undefined) {
          patch.tags = Array.isArray(body.tags)
            ? body.tags.filter((t) => typeof t === 'string')
            : [];
        }
        const updated = deps.repo.update(id, patch);
        if (!updated) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.audit.record({
          kind: 'note_updated',
          actor: 'dashboard',
          detail: { id, fields: Object.keys(patch) },
        });
        return toResponse(updated);
      },
    );

    app.post<{ Params: { id: string }; Body: PinBody }>(
      '/api/notes/:id/pin',
      async (req, reply) => {
        const id = Number(req.params.id);
        const pinned = req.body?.pinned === true;
        const ok = deps.repo.setPinned(id, pinned);
        if (!ok) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.audit.record({
          kind: pinned ? 'note_pinned' : 'note_unpinned',
          actor: 'dashboard',
          detail: { id },
        });
        const row = deps.repo.get(id);
        return row ? toResponse(row) : { ok: true };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/notes/:id/archive',
      async (req, reply) => {
        const id = Number(req.params.id);
        const ok = deps.repo.setArchived(id, true);
        if (!ok) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.audit.record({
          kind: 'note_archived',
          actor: 'dashboard',
          detail: { id },
        });
        const row = deps.repo.get(id);
        return row ? toResponse(row) : { ok: true };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/notes/:id/unarchive',
      async (req, reply) => {
        const id = Number(req.params.id);
        const ok = deps.repo.setArchived(id, false);
        if (!ok) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.audit.record({
          kind: 'note_unarchived',
          actor: 'dashboard',
          detail: { id },
        });
        const row = deps.repo.get(id);
        return row ? toResponse(row) : { ok: true };
      },
    );

    app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
      const id = Number(req.params.id);
      const ok = deps.repo.hardDelete(id);
      if (!ok) {
        reply.code(404);
        return { error: 'not found' };
      }
      deps.audit.record({
        kind: 'note_deleted',
        actor: 'dashboard',
        detail: { id },
      });
      return { ok: true };
    });
  };
