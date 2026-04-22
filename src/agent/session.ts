import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { SessionsRepo, SessionSource } from '../db/repositories/sessions.js';
import type { MessagesRepo } from '../db/repositories/messages.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { MemoryRepo } from '../db/repositories/memory.js';
import type { MemoryManager } from '../memory/manager.js';
import { snapshotToContextFragment } from '../memory/manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import { buildMcpConfig, mcpConfigPath, writeMcpConfig } from '../skills/mcp.js';
import { assembleContext } from './context.js';
import type { ContextAssemblyInput, SkillPromptSnapshot } from './context.js';
import { runClaude } from './runner.js';
import type { RunClaudeResult } from './runner.js';
import type { RateLimitTracker } from './rate-limit-tracker.js';
import { readFileSync } from 'node:fs';

export interface StreamSink {
  onDelta(text: string): void;
  onEnd(result: SessionExecuteResult): Promise<void>;
  onIdleHint?(): void;
}

export interface SessionExecuteInput {
  chatId: string;
  source: SessionSource;
  userMessage: string;
  principalUserId: number | null;
  principalLabel: string;
  model: string;
  timezone: string;
  agentName: string;
  allowedTools: string;
  streamIdleTimeoutMs: number;
  cwd: string;
  /** Where per-session artifacts (.mcp.json) are written. Usually a workspaces subdir. */
  sessionWorkspaceRoot: string;
  conversationBudgetChars?: number;
  sessionIdOverride?: string;
  signal: AbortSignal;
  sink: StreamSink;
  conversationHistoryLimit?: number;
  /** Used to wire memory-proposal MCP server's env contract (DB path, session_id, chat_id). */
  dbPath: string;
  /** How to spawn the memory-proposal MCP server (command + args). */
  memoryProposalServer: { command: string; args: string[] };
  /** Override memory snapshot size (tests). */
  memoryMaxEntries?: number;
}

export interface SessionExecuteDeps {
  sessions: SessionsRepo;
  messages: MessagesRepo;
  audit: AuditRepo;
  memoryRepo: MemoryRepo;
  memoryManager: MemoryManager;
  skills: SkillRegistry;
  logger: Logger;
  /** Captures the latest `rate_limit_event` payload the CLI emits during sessions. */
  rateLimitTracker?: RateLimitTracker;
  /**
   * Used to resolve skill-scoped secrets when building the MCP config. Should
   * wrap the scoped secrets manager so a scope violation throws and audits.
   */
  resolveSkillSecret: (skillName: string, secretName: string) => string | undefined;
}

export interface SessionExecuteResult {
  sessionId: string;
  status: RunClaudeResult['status'];
  error?: string;
  /** Total billable input (sum of fresh + cache_creation + cache_read). */
  tokensInput: number;
  tokensOutput: number;
  /** Breakdown for observability. Same as `RunClaudeResult` fields. */
  tokensInputFresh?: number;
  tokensCacheCreation?: number;
  tokensCacheRead?: number;
  text: string;
  exitCode?: number | null;
  transientApiError?: boolean;
}

/**
 * Orchestrate ONE session end-to-end. See Phase 2 CHANGELOG for prior shape;
 * Phase 3 additions inline below:
 *   - Active memory from MemoryManager is injected into the system prompt.
 *   - Active skills' SKILL.md is injected; their MCP servers are composed
 *     with our memory-proposal server into a per-session .mcp.json.
 *   - Scoped skill secrets are passed via `extraEnv` — filtered through
 *     `resolveSkillSecret` so scope violations are audited.
 */
export async function executeSession(
  input: SessionExecuteInput,
  deps: SessionExecuteDeps,
): Promise<SessionExecuteResult> {
  const sessionId = input.sessionIdOverride ?? randomUUID();

  deps.sessions.create({
    id: sessionId,
    source: input.source,
    source_ref: input.chatId,
    status: 'running',
    input_preview: input.userMessage,
    model: input.model,
  });

  deps.messages.insert({
    session_id: sessionId,
    chat_id: input.chatId,
    role: 'user',
    content: input.userMessage,
  });

  const historyLimit = input.conversationHistoryLimit ?? 50;
  const historyRaw = deps.messages.latestByChat(input.chatId, historyLimit + 1);
  const history = historyRaw.slice(0, -1);

  const sessionScope = input.source === 'group' ? 'group' : 'dm';
  const activeSkills = deps.skills.activeFor(sessionScope);
  const skillNames = activeSkills.map((s) => s.name);

  const memorySnapshot = deps.memoryManager.snapshot(
    {
      principalUserId: input.principalUserId,
      chatId: input.chatId,
      activeSkills: skillNames,
    },
    input.memoryMaxEntries ?? 50,
  );

  const skillPromptSnapshots: SkillPromptSnapshot[] = activeSkills.map((s) => {
    let content = '';
    try {
      content = readFileSync(s.skillMdPath, 'utf8');
    } catch (e) {
      deps.logger.warn(
        { skill: s.name, err: (e as Error).message },
        'could not read SKILL.md — skipping this skill for this session',
      );
    }
    return { name: s.name, skillMdContent: content };
  });

  // Build per-session workspace + .mcp.json.
  const sessionDir = resolve(input.sessionWorkspaceRoot, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const memoryMcpEnv: Record<string, string> = {
    ANDYBIOTICLAW_DB_PATH: input.dbPath,
    ANDYBIOTICLAW_SESSION_ID: sessionId,
    ANDYBIOTICLAW_CHAT_ID: input.chatId,
    // Node needs at least PATH + maybe HOME to load the dist code cleanly.
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  };

  const { config: mcpConfigObject, warnings: mcpWarnings } = buildMcpConfig({
    skills: activeSkills,
    memoryProposalServer: {
      command: input.memoryProposalServer.command,
      args: [...input.memoryProposalServer.args],
      env: memoryMcpEnv,
    },
    getSkillSecret: deps.resolveSkillSecret,
  });
  for (const w of mcpWarnings) deps.logger.warn({ warning: w }, 'mcp config warning');

  const mcpPath = mcpConfigPath(sessionDir);
  writeMcpConfig(mcpPath, mcpConfigObject);

  // Per-skill env additions.
  //
  //  - Secrets: only injected if the skill declares them in required_secrets.
  //    `resolveSkillSecret` throws + audits on scope violations.
  //  - SKILL_<NAME>_DIR: absolute path to the skill's folder, so skill
  //    scripts (e.g. himalaya's commit-send wrapper) can locate their
  //    siblings without hard-coding paths. Name case: underscores instead
  //    of hyphens, uppercase. `himalaya` → `SKILL_HIMALAYA_DIR`.
  //  - ANDYBIOTICLAW_SESSION_ID + ANDYBIOTICLAW_DB_PATH + ANDYBIOTICLAW_CHAT_ID:
  //    used by skill wrappers that write to our SQLite DB with a session
  //    invariant (e.g. the himalaya HITL send gate).
  const extraEnv: Record<string, string> = {
    ANDYBIOTICLAW_SESSION_ID: sessionId,
    ANDYBIOTICLAW_CHAT_ID: input.chatId,
    ANDYBIOTICLAW_DB_PATH: input.dbPath,
  };
  for (const skill of activeSkills) {
    const envKey = `SKILL_${skill.name.toUpperCase().replace(/-/g, '_')}_DIR`;
    extraEnv[envKey] = skill.skillDir;
    for (const secretName of skill.requiredSecrets) {
      try {
        const value = deps.resolveSkillSecret(skill.name, secretName);
        if (value !== undefined) extraEnv[secretName] = value;
      } catch (e) {
        deps.logger.warn(
          { skill: skill.name, secret: secretName, err: (e as Error).message },
          'skill secret resolution threw — skipping',
        );
      }
    }
  }

  const { systemPrompt } = assembleContext({
    agentName: input.agentName,
    model: input.model,
    timezone: input.timezone,
    principalLabel: input.principalLabel,
    activeMemory: snapshotToContextFragment(memorySnapshot),
    activeSkills: skillPromptSnapshots,
    conversationHistory: history,
    memoryToolDescribed: true,
    ...(input.conversationBudgetChars !== undefined
      ? { historyBudgetChars: input.conversationBudgetChars }
      : {}),
  } as ContextAssemblyInput);

  const runResult = await runClaude({
    userMessage: input.userMessage,
    systemPrompt,
    model: input.model,
    cwd: input.cwd,
    allowedTools: input.allowedTools,
    streamIdleTimeoutMs: input.streamIdleTimeoutMs,
    signal: input.signal,
    mcpConfigPath: mcpPath,
    extraEnv,
    onDelta: (t) => {
      try {
        input.sink.onDelta(t);
      } catch (e) {
        deps.logger.warn({ err: (e as Error).message }, 'sink.onDelta threw');
      }
    },
    onRateLimit: (info) => {
      deps.logger.debug({ info }, 'rate-limit event from claude');
      deps.rateLimitTracker?.record(info);
    },
    onToolUse: (name) => {
      deps.logger.debug({ tool: name }, 'tool use observed');
    },
    logger: deps.logger,
  });

  deps.sessions.update(sessionId, {
    status: runResult.status === 'completed' ? 'completed' : runResult.status,
    tokens_input: runResult.tokensInput,
    tokens_output: runResult.tokensOutput,
    ended_at: Date.now(),
    error: runResult.error ?? null,
  });

  if (runResult.text) {
    deps.messages.insert({
      session_id: sessionId,
      chat_id: input.chatId,
      role: 'assistant',
      content: runResult.text,
    });
  }

  if (runResult.transientApiError) {
    deps.audit.record({
      kind: 'transient_api_error',
      actor: input.chatId,
      detail: { sessionId, error: runResult.error },
    });
  }

  if (runResult.killedByApiKeyGuard) {
    deps.audit.record({
      kind: 'api_key_billing_blocked',
      actor: input.chatId,
      detail: {
        sessionId,
        apiKeySource: runResult.apiKeySource,
        hint: 'subscription auth required — unset ANTHROPIC_API_KEY et al. in the service env',
      },
    });
    deps.logger.error(
      { sessionId, apiKeySource: runResult.apiKeySource },
      'session aborted to prevent API-key billing — check the service env for ANTHROPIC_API_KEY',
    );
  }

  const finalResult: SessionExecuteResult = {
    sessionId,
    status: runResult.status,
    ...(runResult.error ? { error: runResult.error } : {}),
    tokensInput: runResult.tokensInput,
    tokensOutput: runResult.tokensOutput,
    text: runResult.text,
    ...(runResult.tokensInputFresh !== undefined
      ? { tokensInputFresh: runResult.tokensInputFresh }
      : {}),
    ...(runResult.tokensCacheCreation !== undefined
      ? { tokensCacheCreation: runResult.tokensCacheCreation }
      : {}),
    ...(runResult.tokensCacheRead !== undefined
      ? { tokensCacheRead: runResult.tokensCacheRead }
      : {}),
    exitCode: runResult.exitCode ?? null,
    ...(runResult.transientApiError ? { transientApiError: true } : {}),
  };

  await input.sink.onEnd(finalResult);
  return finalResult;
}
