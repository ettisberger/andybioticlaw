#!/usr/bin/env node
/**
 * Stdio MCP server exposing a single tool: `memory_propose`.
 *
 * The core service spawns this server per agent session (via the generated
 * `.mcp.json`) so the agent can propose memory entries for the user to review.
 * Proposals go straight into SQLite (`memory_proposals` table); the main
 * service scans pending proposals after session end and sends inline buttons.
 *
 * Environment contract (set by the core service when generating the MCP config):
 *   ANDYBIOTICLAW_DB_PATH    — absolute path to the service SQLite DB
 *   ANDYBIOTICLAW_SESSION_ID — current agent session UUID
 *   ANDYBIOTICLAW_CHAT_ID    — Telegram chat id of the current session
 *
 * Runs as its own Node process. Shares the DB with the core service via WAL.
 */

import Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const dbPath = process.env.ANDYBIOTICLAW_DB_PATH;
const sessionId = process.env.ANDYBIOTICLAW_SESSION_ID;
const chatId = process.env.ANDYBIOTICLAW_CHAT_ID;

if (!dbPath || !sessionId || !chatId) {
  process.stderr.write(
    'memory-proposal-server: missing required env (ANDYBIOTICLAW_DB_PATH, _SESSION_ID, _CHAT_ID)\n',
  );
  process.exit(64);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const insertProposal = db.prepare(
  `INSERT INTO memory_proposals (session_id, chat_id, scope, proposed_value, proposed_key, ttl_seconds, status, created_at)
   VALUES (@session_id, @chat_id, @scope, @proposed_value, @proposed_key, @ttl_seconds, 'pending', @created_at)`,
);

const SERVER_NAME = 'andybioticlaw-memory';
const TOOL_NAME = 'memory_propose';

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Queue a memory entry for the user to accept or dismiss via inline button in Telegram. Use this when you learn something worth remembering for future sessions — preferences, facts, long-lived context. Keep entries terse and load-bearing; not chronological summaries.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description:
          'Scope for this memory. One of: "global" (all chats), "user:<id>" (a specific user), "chat:<id>" (a specific chat). If unsure, use "global".',
      },
      value: {
        type: 'string',
        description:
          'The memory text the user will see and approve. One or two sentences max.',
      },
      key: {
        type: 'string',
        description:
          'Optional short identifier for this memory entry (e.g. "pref/language"). Omit when unsure.',
      },
      ttl_seconds: {
        type: 'integer',
        description:
          'Optional: if this memory should auto-expire, how many seconds from acceptance until it is removed.',
        minimum: 60,
      },
    },
    required: ['scope', 'value'],
  },
} as const;

const server = new Server(
  { name: SERVER_NAME, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL_DEFINITION],
}));

interface MemoryProposeArgs {
  scope: string;
  value: string;
  key?: string;
  ttl_seconds?: number;
}

const VALID_SCOPE_RE = /^(global|user:[\w\-.]+|chat:-?[\w\-.]+|skill:[a-z0-9-]+)$/;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    };
  }
  const args = (req.params.arguments ?? {}) as Partial<MemoryProposeArgs>;
  const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
  const value = typeof args.value === 'string' ? args.value.trim() : '';
  const key =
    typeof args.key === 'string' && args.key.trim().length > 0
      ? args.key.trim()
      : null;
  const ttlSeconds =
    typeof args.ttl_seconds === 'number' && args.ttl_seconds > 0
      ? Math.floor(args.ttl_seconds)
      : null;

  if (!value) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'value is required and must be non-empty' }],
    };
  }
  if (!scope || !VALID_SCOPE_RE.test(scope)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `scope is required and must match global | user:<id> | chat:<id> | skill:<name>; got "${scope}"`,
        },
      ],
    };
  }

  try {
    const result = insertProposal.run({
      session_id: sessionId,
      chat_id: chatId,
      scope,
      proposed_value: value,
      proposed_key: key,
      ttl_seconds: ttlSeconds,
      created_at: Date.now(),
    });
    return {
      content: [
        {
          type: 'text',
          text: `queued memory proposal #${Number(result.lastInsertRowid)} (scope: ${scope}) — user will see an inline button after this response.`,
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `failed to queue proposal: ${(e as Error).message}` },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown — drop the DB handle before exit.
const cleanup = () => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
