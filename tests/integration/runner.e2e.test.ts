import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { executeSession } from '../../src/agent/session.js';
import { createSessionsRepo } from '../../src/db/repositories/sessions.js';
import { createMessagesRepo } from '../../src/db/repositories/messages.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';
import { createMemoryRepo } from '../../src/db/repositories/memory.js';
import { createMemoryManager } from '../../src/memory/manager.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import type { SessionExecuteResult, StreamSink } from '../../src/agent/session.js';

/**
 * End-to-end smoke test that actually spawns the real `claude` CLI.
 *
 * Gated behind the `CLAUDE_E2E` env var so `pnpm test` on CI (or any box
 * without a logged-in claude subscription) doesn't pay the real-API cost.
 * Run locally with: `CLAUDE_E2E=1 pnpm test`.
 */
const ENABLED = process.env.CLAUDE_E2E === '1';
const d = ENABLED ? describe : describe.skip;

d('executeSession against real claude CLI', () => {
  const logger = pino({ level: 'silent' });

  it(
    'runner uses subscription auth even when parent env has ANTHROPIC_API_KEY set',
    async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-BOGUS-not-a-real-key';

      try {
        const { runClaude } = await import('../../src/agent/runner.js');
        let initApiKeySource: string | undefined;
        const controller = new AbortController();
        const result = await runClaude({
          userMessage: 'Reply with exactly the word: subscription',
          systemPrompt: 'You answer tersely.',
          model: 'claude-haiku-4-5-20251001',
          cwd: process.cwd(),
          streamIdleTimeoutMs: 120_000,
          signal: controller.signal,
          onDelta: () => {},
          onInit: ({ apiKeySource }) => {
            initApiKeySource = apiKeySource;
          },
          logger,
        });

        expect(initApiKeySource).toBe('none');
        expect(result.status).toBe('completed');
        expect(result.killedByApiKeyGuard).toBeUndefined();
        // apiKeySource must NOT be in the reject-list. Accepts keyring
        // session ('none') OR CLAUDE_CODE_OAUTH_TOKEN paths; rejects
        // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (pay-as-you-go).
        expect(result.apiKeySource).toBeDefined();
        expect(
          ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(
            result.apiKeySource!,
          ),
        ).toBe(false);
        expect(result.tokensInput).toBeGreaterThan(0);
        expect(result.tokensOutput).toBeGreaterThan(0);
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    },
    60_000,
  );

  function setup() {
    const dbPath = resolve(mkdtempSync(resolve(tmpdir(), 'andy-e2e-')), 'test.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
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
    const memoryRepo = createMemoryRepo(db);
    return {
      sessions: createSessionsRepo(db),
      messages: createMessagesRepo(db),
      audit: createAuditRepo(db),
      memoryRepo,
      memoryManager: createMemoryManager({ repo: memoryRepo, logger }),
      skills: createSkillRegistry(db),
      db,
      dbPath,
    };
  }

  beforeAll(() => {
    /* warmup */
  });

  it(
    'streams a short reply and completes with non-zero tokens',
    async () => {
      const env = setup();
      const deltas: string[] = [];
      const controller = new AbortController();

      const sink: StreamSink = {
        onDelta: (t) => deltas.push(t),
        async onEnd(_result) {
          /* noop */
        },
      };

      const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'andy-e2e-ws-'));

      const memoryServerPath = resolve(
        __dirname,
        '..',
        '..',
        'src',
        'mcp',
        'memory-proposal-server.ts',
      );
      const tsxCli = resolve(
        __dirname,
        '..',
        '..',
        'node_modules',
        'tsx',
        'dist',
        'cli.mjs',
      );

      const result: SessionExecuteResult = await executeSession(
        {
          chatId: 'test-chat',
          source: 'dm',
          userMessage: 'Reply with exactly one word: OK',
          principalUserId: null,
          principalLabel: 'test',
          model: 'claude-haiku-4-5-20251001',
          timezone: 'Europe/Zurich',
          agentName: 'Emma',
          agentId: 'emma',
          streamIdleTimeoutMs: 120_000,
          cwd: process.cwd(),
          sessionWorkspaceRoot: workspaceRoot,
          dbPath: env.dbPath,
          memoryProposalServer: { command: process.execPath, args: [tsxCli, memoryServerPath] },
          signal: controller.signal,
          sink,
        },
        {
          sessions: env.sessions,
          messages: env.messages,
          audit: env.audit,
          memoryRepo: env.memoryRepo,
          memoryManager: env.memoryManager,
          skills: env.skills,
          resolveSkillSecret: () => undefined,
          logger,
        },
      );

      expect(result.status).toBe('completed');
      expect(result.tokensInput).toBeGreaterThan(0);
      expect(result.tokensOutput).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
      expect(deltas.length).toBeGreaterThan(0);

      const row = env.sessions.get(result.sessionId);
      expect(row).not.toBeNull();
      expect(row!.status).toBe('completed');
      expect(row!.tokens_input).toBe(result.tokensInput);

      const msgs = env.messages.latestByChat('test-chat', 10);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe('user');
      expect(msgs[1]!.role).toBe('assistant');
    },
    90_000,
  );

  it(
    'agent can queue a memory proposal via the memory-proposal MCP tool',
    async () => {
      const env = setup();
      const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'andy-e2e-mem-'));
      const memoryServerPath = resolve(
        __dirname,
        '..',
        '..',
        'src',
        'mcp',
        'memory-proposal-server.ts',
      );
      const tsxCli = resolve(
        __dirname,
        '..',
        '..',
        'node_modules',
        'tsx',
        'dist',
        'cli.mjs',
      );

      const controller = new AbortController();
      const sink: StreamSink = {
        onDelta: () => {},
        async onEnd(_result) {
          /* noop */
        },
      };

      const result = await executeSession(
        {
          chatId: 'mem-chat',
          source: 'dm',
          userMessage:
            'I speak Swiss German. Please use the memory_propose tool to queue a single global memory entry that records this preference, then reply with just the word "done".',
          principalUserId: 12345,
          principalLabel: 'test',
          model: 'claude-opus-4-7',
          timezone: 'Europe/Zurich',
          agentName: 'Emma',
          agentId: 'emma',
          streamIdleTimeoutMs: 120_000,
          cwd: process.cwd(),
          sessionWorkspaceRoot: workspaceRoot,
          dbPath: env.dbPath,
          memoryProposalServer: { command: process.execPath, args: [tsxCli, memoryServerPath] },
          signal: controller.signal,
          sink,
        },
        {
          sessions: env.sessions,
          messages: env.messages,
          audit: env.audit,
          memoryRepo: env.memoryRepo,
          memoryManager: env.memoryManager,
          skills: env.skills,
          resolveSkillSecret: () => undefined,
          logger,
        },
      );

      expect(result.status).toBe('completed');

      const pending = env.memoryRepo.proposalListPending(result.sessionId);
      expect(pending.length).toBeGreaterThanOrEqual(1);
      const p = pending[0]!;
      expect(p.scope.startsWith('global') || p.scope.startsWith('user:')).toBe(true);
      expect(p.proposed_value.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
