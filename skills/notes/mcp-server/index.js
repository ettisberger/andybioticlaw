#!/usr/bin/env node
/**
 * Notes MCP server. Spawned per agent session by the core service when
 * the `notes` skill is active.
 *
 * Exposes 6 tools (create/list/get/update/archive/unarchive) backed by
 * the project's SQLite DB. Reads ANDYBIOTICLAW_DB_PATH from the
 * framework env injected by the harness (see src/skills/mcp.ts →
 * frameworkEnv).
 *
 * Hard-delete is intentionally NOT exposed here — it's dashboard-only.
 * The agent gets a soft archive at most.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';

const DB_PATH = process.env.ANDYBIOTICLAW_DB_PATH;
if (!DB_PATH) {
  process.stderr.write(
    'notes-mcp-server: ANDYBIOTICLAW_DB_PATH is unset — the framework should inject it. Aborting.\n',
  );
  process.exit(64);
}

// Open in WAL-friendly mode: the main service is the writer; we open
// readonly-ish behaviour by accepting whatever pragma state the DB has.
// `better-sqlite3` shares the WAL with the main process via the shared
// memory mapping; concurrent reads are safe and writes serialise on the
// SQLite lock.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SERVER_NAME = 'notes';

const TOOLS = [
  {
    name: 'create_note',
    description:
      "Save a new note. Use this when the principal asks to 'save', 'note', 'remember as a note', or similar. Body is markdown; title is optional (the dashboard derives one from the first line if omitted); tags is an optional array of freeform string labels.",
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: {
          type: 'string',
          description: 'Markdown body of the note. Required.',
        },
        title: {
          type: 'string',
          description: 'Optional short title. If omitted the dashboard derives one from the first line of the body.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional freeform tag labels. Lowercased single words usually work best.',
        },
      },
    },
  },
  {
    name: 'list_notes',
    description:
      'List notes, newest-first (pinned float to top). With `query` set, runs an FTS5 full-text search over title + body + tags, ranked by relevance. With `tag` set, filters to notes whose tags include that string. Returns truncated snippets — call `get_note` for the full body.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search across title, body, and tags. Treated as a phrase.',
        },
        tag: {
          type: 'string',
          description: 'Restrict results to notes carrying this exact tag string.',
        },
        limit: {
          type: 'integer',
          description: 'Max number of notes to return. Defaults to 20.',
          default: 20,
          minimum: 1,
          maximum: 100,
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include soft-archived notes. Defaults to false.',
          default: false,
        },
      },
    },
  },
  {
    name: 'get_note',
    description:
      "Fetch a single note's full body and metadata. Use this after `list_notes` returns a snippet you need to expand.",
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', description: 'Note id from list_notes.' },
      },
    },
  },
  {
    name: 'update_note',
    description:
      'Update one or more fields of an existing note. Send only the fields that change. Bumps updated_at.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        body: { type: 'string', description: 'New markdown body. Replaces the previous body in full.' },
        title: { type: ['string', 'null'], description: 'New title, or null to clear.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement tag list. Pass [] to clear all tags.',
        },
      },
    },
  },
  {
    name: 'archive_note',
    description:
      'Soft-delete a note. It disappears from the default `list_notes` results but remains in the DB and can be restored with `unarchive_note`. This is the only "delete" you can do — hard deletes are dashboard-only.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer' } },
    },
  },
  {
    name: 'unarchive_note',
    description: 'Restore a previously archived note to the active list.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer' } },
    },
  },
];

// Prepared statements ------------------------------------------------------

const insertNote = db.prepare(
  `INSERT INTO notes (user_id, title, body, tags, source, created_at, updated_at)
   VALUES (NULL, @title, @body, @tags, 'agent', @ts, @ts)`,
);

const selectById = db.prepare(`SELECT * FROM notes WHERE id = @id`);

const setArchived = db.prepare(
  `UPDATE notes SET archived = @archived, updated_at = @ts WHERE id = @id`,
);

function quoteFtsQuery(raw) {
  return `"${raw.replace(/"/g, '""')}"`;
}

function listNotes({ query, tag, limit = 20, includeArchived = false }) {
  const params = { limit };
  const where = [];
  if (!includeArchived) where.push('n.archived = 0');
  if (tag) {
    where.push(`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = @tag)`);
    params.tag = tag;
  }
  let sql;
  if (query && query.trim() !== '') {
    params.q = quoteFtsQuery(query.trim());
    const w = where.length ? `AND ${where.join(' AND ')}` : '';
    sql = `SELECT n.* FROM notes n
           JOIN notes_fts f ON f.rowid = n.id
           WHERE notes_fts MATCH @q ${w}
           ORDER BY n.pinned DESC, bm25(notes_fts), n.updated_at DESC
           LIMIT @limit`;
  } else {
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    sql = `SELECT n.* FROM notes n
           ${w}
           ORDER BY n.pinned DESC, n.updated_at DESC
           LIMIT @limit`;
  }
  return db.prepare(sql).all(params);
}

function compactNote(row) {
  return {
    id: row.id,
    title: row.title,
    snippet: row.body.length > 200 ? row.body.slice(0, 200) + '…' : row.body,
    tags: safeParseTags(row.tags),
    pinned: row.pinned === 1,
    source: row.source,
    updated_at: row.updated_at,
  };
}

function fullNote(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: safeParseTags(row.tags),
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParseTags(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// MCP wiring --------------------------------------------------------------

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `ERROR: ${message}` }], isError: true };
}

const server = new Server(
  { name: SERVER_NAME, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'create_note': {
        if (!args.body || typeof args.body !== 'string') {
          return errorResult('body is required and must be a string');
        }
        const ts = Date.now();
        const tagsJson = JSON.stringify(
          Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [],
        );
        const result = insertNote.run({
          title: args.title ?? null,
          body: args.body,
          tags: tagsJson,
          ts,
        });
        const row = selectById.get({ id: Number(result.lastInsertRowid) });
        return textResult(fullNote(row));
      }

      case 'list_notes': {
        const rows = listNotes({
          query: args.query,
          tag: args.tag,
          limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
          includeArchived: args.includeArchived === true,
        });
        return textResult({
          notes: rows.map(compactNote),
          count: rows.length,
        });
      }

      case 'get_note': {
        if (typeof args.id !== 'number') return errorResult('id is required');
        const row = selectById.get({ id: args.id });
        if (!row) return errorResult(`note ${args.id} not found`);
        return textResult(fullNote(row));
      }

      case 'update_note': {
        if (typeof args.id !== 'number') return errorResult('id is required');
        const sets = [];
        const params = { id: args.id, ts: Date.now() };
        if (args.body !== undefined) {
          sets.push('body = @body');
          params.body = args.body;
        }
        if (args.title !== undefined) {
          sets.push('title = @title');
          params.title = args.title;
        }
        if (args.tags !== undefined) {
          sets.push('tags = @tags');
          params.tags = JSON.stringify(
            Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [],
          );
        }
        if (sets.length === 0) return errorResult('no fields to update');
        sets.push('updated_at = @ts');
        const r = db
          .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = @id`)
          .run(params);
        if (r.changes === 0) return errorResult(`note ${args.id} not found`);
        const row = selectById.get({ id: args.id });
        return textResult(fullNote(row));
      }

      case 'archive_note': {
        if (typeof args.id !== 'number') return errorResult('id is required');
        const r = setArchived.run({ id: args.id, archived: 1, ts: Date.now() });
        if (r.changes === 0) return errorResult(`note ${args.id} not found`);
        return textResult({ archived: true, id: args.id });
      }

      case 'unarchive_note': {
        if (typeof args.id !== 'number') return errorResult('id is required');
        const r = setArchived.run({ id: args.id, archived: 0, ts: Date.now() });
        if (r.changes === 0) return errorResult(`note ${args.id} not found`);
        return textResult({ archived: false, id: args.id });
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e?.message ?? String(e));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
