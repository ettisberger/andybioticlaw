import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { SessionsRepo, SessionSource } from '../db/repositories/sessions.js';
import type { MessagesRepo } from '../db/repositories/messages.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { MemoryRepo } from '../db/repositories/memory.js';
import type { MemoryManager } from '../memory/manager.js';
import type { ResolvedPolicy } from '../policies/schema.js';
import { snapshotToContextFragment } from '../memory/manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import { buildMcpConfig, mcpConfigPath, writeMcpConfig } from '../skills/mcp.js';
import { applySkillTemplating } from '../skills/templating.js';
import { assembleContext } from './context.js';
import type { ContextAssemblyInput, SkillPromptSnapshot } from './context.js';
import { runClaude } from './runner.js';
import { projectRoot } from '../config/load.js';
import { defaultConfigPath } from '../config/paths.js';
import type { RunClaudeResult } from './runner.js';
import type { RateLimitTracker } from './rate-limit-tracker.js';
import type { LiveSessionsTracker } from '../observability/live-sessions.js';
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
  /** Stable id of the agent running this session — recorded on the
   *  sessions table so per-agent dashboards / metrics work. */
  agentId: string;
  /**
   * The agent's `skills` config: `['*']` for "all enabled skills",
   * or an explicit subset list. Combined with the resolved policy's
   * `skillsVisible` to decide what skills this session sees. Defaults
   * to `['*']` so legacy / test callers that omit it preserve today's
   * behaviour (= every enabled skill).
   */
  agentSkills?: ReadonlyArray<string>;
  /**
   * Optional per-agent system prompt override. When set, the prompt
   * assembly reads this file (resolved against project root) instead
   * of the bundled `system.base.md`. Lets a non-default agent ship
   * its own persona + voice.
   */
  agentSystemPromptFile?: string;
  /**
   * Optional name of the env var holding this agent's long-lived
   * Claude OAuth token. When set, the runner reads
   * `process.env[agentTokenEnvVar]` and injects it as
   * `CLAUDE_CODE_OAUTH_TOKEN` into the spawned session — this is how
   * two agents on one host can use two different subscriptions.
   * Unset → fall back to whatever `CLAUDE_CODE_OAUTH_TOKEN` is in
   * the parent process env (the default for agents that don't pin a
   * custom token env var).
   */
  agentTokenEnvVar?: string;
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
  /**
   * Shared mutable Set populated by executeSession with every
   * skill-scoped secret value for this session's active skills.
   * The caller (dispatch.ts) reads it from its sink's SecretsProvider
   * on every Telegram flush to redact outbound text.
   *
   * Ref-passing pattern: the sink is constructed BEFORE
   * executeSession runs (it's needed for the "… working" opening
   * message), so we can't hand the final skill-secret set to it at
   * construction time. Instead we share a mutable ref — session
   * populates it once active skills are known; sink reads it fresh
   * on each flush. Since the sink only streams AFTER session starts,
   * the ref is always populated before its first read.
   */
  secretsRef?: { values: Set<string> };
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
  /**
   * Optional dashboard live-session tracker. When present, start/onDelta/
   * onToolUse/end are called so the `/api/sessions/live` endpoints see
   * in-flight state. Omitted in tests.
   */
  liveSessions?: LiveSessionsTracker;
  /**
   * Resolves the per-context permission policy at session start. When
   * present, the harness writes a `.claude/settings.json` into the
   * session workspace and passes it to Claude via `--settings`. Skills'
   * `exec_allow` patterns are merged in. When absent (legacy callers /
   * tests), the runner keeps its today's behaviour: `bypassPermissions`
   * with no settings file.
   */
  resolvePolicy?: (contextKey: string) => ResolvedPolicy;
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
    agent_id: input.agentId,
  });

  deps.liveSessions?.start({
    sessionId,
    chatId: input.chatId,
    source: input.source,
  });

  try {
    return await runOne(sessionId, input, deps);
  } finally {
    deps.liveSessions?.end(sessionId);
  }
}

async function runOne(
  sessionId: string,
  input: SessionExecuteInput,
  deps: SessionExecuteDeps,
): Promise<SessionExecuteResult> {
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

  // Resolve the per-context policy FIRST so we can intersect its
  // `skillsVisible` with the agent's `skills` config when filtering
  // the registry. The policy is also used later to write the per-
  // session `.claude/settings.json`. Resolving once up-front avoids
  // a second resolvePolicy call.
  let resolvedPolicyForSession: ResolvedPolicy | null = null;
  let policyContextKey: string | null = null;
  if (deps.resolvePolicy) {
    const { contextKey: makeContextKey } = await import('./runtime-context.js');
    policyContextKey = makeContextKey({
      agentId: input.agentId,
      channel: 'telegram',
      chatId: Number(input.chatId),
    });
    try {
      resolvedPolicyForSession = deps.resolvePolicy(policyContextKey);
    } catch (e) {
      deps.logger.warn(
        { err: (e as Error).message, ctxKey: policyContextKey },
        'policy resolution failed — falling back to bypassPermissions',
      );
    }
  }

  // Filter the skill registry by agent.skills × policy.skillsVisible.
  // Defaults: if the input doesn't supply agent.skills (legacy callers
  // / tests), behave as if `['*']`; if no policy, behave as if
  // `['*']`. So today's tests + dispatchers without policy keep their
  // current "every enabled skill" behaviour.
  const agentSkills = input.agentSkills ?? ['*'];
  const policySkillsVisible = resolvedPolicyForSession?.skillsVisible ?? ['*'];
  const activeSkills = deps.skills.activeForAgent(
    sessionScope,
    agentSkills,
    policySkillsVisible,
  );
  const skillNames = activeSkills.map((s) => s.name);

  const memorySnapshot = deps.memoryManager.snapshot(
    {
      principalUserId: input.principalUserId,
      chatId: input.chatId,
      activeSkills: skillNames,
    },
    input.memoryMaxEntries ?? 50,
  );

  // Resolve config path once for both env-injection (browser MCP server
  // reads the live YAML to honor hot-reloaded allowlist) and for the
  // SKILL.md `{{profiles}}` substitution below.
  const configPathForSession =
    process.env.ANDYBIOTICLAW_CONFIG_PATH ?? defaultConfigPath(projectRoot());

  const skillPromptSnapshots: SkillPromptSnapshot[] = activeSkills.map((s) => {
    let content = '';
    try {
      content = readFileSync(s.skillMdPath, 'utf8');
      content = applySkillTemplating({
        skillName: s.name,
        content,
        configPath: configPathForSession,
      });
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

  // dbPath is at `<dataDir>/db/andybioticlaw.db` — walk up twice for dataDir.
  const dataDirForEnv = dirname(dirname(input.dbPath));

  const memoryMcpEnv: Record<string, string> = {
    ANDYBIOTICLAW_DB_PATH: input.dbPath,
    ANDYBIOTICLAW_SESSION_ID: sessionId,
    ANDYBIOTICLAW_CHAT_ID: input.chatId,
    // Skills like `browser` that need to read live config from disk
    // (allowlist hot-reload) use this. Other skills can ignore it.
    ANDYBIOTICLAW_CONFIG_PATH: configPathForSession,
    // Where the browser skill keeps its Chromium binaries. MUST be set
    // here (in the parent-spawned env) rather than inside the MCP
    // server's constructor — Playwright caches the browser-registry
    // lookup at the moment it's imported, so a later
    // `process.env.PLAYWRIGHT_BROWSERS_PATH = ...` is too late and
    // Playwright falls back to `~/.cache/ms-playwright`, finds nothing,
    // and reports "Executable doesn't exist — run npx playwright
    // install." Set unconditionally because (a) skills that don't use
    // playwright simply ignore it, (b) we want a single code path,
    // not a per-skill conditional.
    PLAYWRIGHT_BROWSERS_PATH: resolve(dataDirForEnv, 'cache/playwright'),
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
    // Same env the memory MCP server gets — every skill MCP server needs
    // PATH/HOME at minimum, and any skill that talks to our SQLite DB
    // (e.g. the `notes` skill) reaches it via ANDYBIOTICLAW_DB_PATH.
    frameworkEnv: memoryMcpEnv,
    getSkillSecret: deps.resolveSkillSecret,
  });
  for (const w of mcpWarnings) deps.logger.warn({ warning: w }, 'mcp config warning');

  const mcpPath = mcpConfigPath(sessionDir);
  writeMcpConfig(mcpPath, mcpConfigObject);

  // Per-session .claude/settings.json. Only generated when the caller
  // provides a policy resolver — otherwise we keep today's
  // `--permission-mode bypassPermissions` behaviour for backward compat
  // with tests + legacy callers.
  let claudeSettingsPath: string | undefined;
  let permissionMode: 'bypassPermissions' | 'default' = 'bypassPermissions';
  if (resolvedPolicyForSession && policyContextKey) {
    const { buildClaudeSessionSettings } = await import('./claude-settings.js');
    const settings = buildClaudeSessionSettings({
      policy: resolvedPolicyForSession,
      skills: activeSkills.map((s) => ({ name: s.name, execAllow: s.execAllow })),
      contextKey: policyContextKey,
    });
    // Claude Code reads `.claude/settings.json` in the cwd OR the
    // exact path passed via `--settings`. We use the `--settings`
    // form so the file lives inside the session workspace and gets
    // cleaned up with the rest of session artifacts.
    const { writeFileSync, mkdirSync, existsSync: exists } = await import('node:fs');
    const { resolve: rpath } = await import('node:path');
    const settingsDir = rpath(sessionDir, '.claude');
    if (!exists(settingsDir)) mkdirSync(settingsDir, { recursive: true });
    claudeSettingsPath = rpath(settingsDir, 'settings.json');
    writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n', {
      mode: 0o600,
    });
    permissionMode = settings.permissions.defaultMode;
  }

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
    // The CLI's `schedule add` command reads this to look up the
    // policy.scheduleKinds for the agent's current context. Replaces
    // the old ANDYBIOTICLAW_AGENT_CAN_BASH=1 env-var gate.
    ANDYBIOTICLAW_CONTEXT_KEY: `${input.agentId}:telegram:${input.chatId}`,
  };

  // Per-agent OAuth token: when the agent config sets `tokenEnvVar`,
  // resolve that env var in the parent process and route it to the
  // child as CLAUDE_CODE_OAUTH_TOKEN. Lets two agents on one host
  // run on two different Claude subscriptions. If the var is set but
  // empty, log a warn and fall through to whatever
  // CLAUDE_CODE_OAUTH_TOKEN is already in the env (default agent's
  // token, possibly).
  if (input.agentTokenEnvVar) {
    const token = process.env[input.agentTokenEnvVar];
    if (token && token.trim() !== '') {
      extraEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
      // Tell the outbound redactor about this token so any literal
      // appearance in the agent's reply (e.g. an error message that
      // echoes the env var, or a prompt-injection echo) gets scrubbed
      // before reaching Telegram. Same pattern as the skill-secret
      // loop below; without this, a per-agent token is unredacted.
      input.secretsRef?.values.add(token);
    } else {
      deps.logger.warn(
        { agentId: input.agentId, tokenEnvVar: input.agentTokenEnvVar },
        'agent.tokenEnvVar set but the env var is empty — falling back to CLAUDE_CODE_OAUTH_TOKEN',
      );
    }
  }
  for (const skill of activeSkills) {
    const envKey = `SKILL_${skill.name.toUpperCase().replace(/-/g, '_')}_DIR`;
    extraEnv[envKey] = skill.skillDir;
    for (const secretName of skill.requiredSecrets) {
      try {
        const value = deps.resolveSkillSecret(skill.name, secretName);
        if (value !== undefined) {
          extraEnv[secretName] = value;
          // Also tell the outbound redactor about this value so any
          // literal appearance in Emma's replies gets scrubbed. See
          // the ref-passing pattern note on SessionExecuteInput.
          input.secretsRef?.values.add(value);
        }
      } catch (e) {
        deps.logger.warn(
          { skill: skill.name, secret: secretName, err: (e as Error).message },
          'skill secret resolution threw — skipping',
        );
      }
    }
  }

  // Per-agent system prompt override: if the agent config has a
  // systemPromptFile, route it through the existing
  // `basePromptPathOverride` knob. The path is resolved against
  // project root so an operator can ship `prompts/work-agent.md`
  // alongside their config.
  const basePromptPathOverride = input.agentSystemPromptFile
    ? resolve(projectRoot(), input.agentSystemPromptFile)
    : undefined;

  const { systemPrompt } = assembleContext({
    agentName: input.agentName,
    model: input.model,
    timezone: input.timezone,
    principalLabel: input.principalLabel,
    activeMemory: snapshotToContextFragment(memorySnapshot),
    activeSkills: skillPromptSnapshots,
    conversationHistory: history,
    memoryToolDescribed: true,
    ...(basePromptPathOverride ? { basePromptPathOverride } : {}),
    ...(input.conversationBudgetChars !== undefined
      ? { historyBudgetChars: input.conversationBudgetChars }
      : {}),
  } as ContextAssemblyInput);

  const runResult = await runClaude({
    userMessage: input.userMessage,
    systemPrompt,
    model: input.model,
    cwd: input.cwd,
    streamIdleTimeoutMs: input.streamIdleTimeoutMs,
    signal: input.signal,
    mcpConfigPath: mcpPath,
    permissionMode,
    ...(claudeSettingsPath ? { settingsPath: claudeSettingsPath } : {}),
    extraEnv,
    onDelta: (t) => {
      try {
        input.sink.onDelta(t);
      } catch (e) {
        deps.logger.warn({ err: (e as Error).message }, 'sink.onDelta threw');
      }
      deps.liveSessions?.onDelta(sessionId, t);
    },
    onRateLimit: (info) => {
      deps.logger.debug({ info }, 'rate-limit event from claude');
      deps.rateLimitTracker?.record(info);
    },
    onToolUse: (name) => {
      deps.logger.debug({ tool: name }, 'tool use observed');
      deps.liveSessions?.onToolUse(sessionId, name);
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
