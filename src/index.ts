import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapEnv, loadConfig, ConfigLoadError, projectRoot } from './config/load.js';
import { getDefaultAgent } from './config/agents-helper.js';
import { resolveBinding } from './agent/runtime-context.js';
import { createReloadController } from './config/reload.js';
import {
  createSecretsManager,
  envSecretsStore,
  liveSkillPermissions,
} from './config/secrets.js';
import {
  expandPath,
  logsDir,
  policiesPath,
  sqliteDbPath,
  pidFilePath,
  workspacesDir,
} from './config/paths.js';
import { loadPolicies, resolvePolicy as resolvePolicyFn, savePolicies } from './policies/repo.js';
import { synthesizeDefaultPolicies } from './policies/auto-generate.js';
import { openDatabase } from './db/index.js';
import { createAuditRepo } from './db/repositories/audit.js';
import { createHeartbeatsRepo } from './db/repositories/heartbeats.js';
import { createSessionsRepo } from './db/repositories/sessions.js';
import { createMessagesRepo } from './db/repositories/messages.js';
import { createMemoryRepo } from './db/repositories/memory.js';
import { createNotesRepo } from './db/repositories/notes.js';
import { createMemoryManager } from './memory/manager.js';
import { createMemoryTtlCron } from './memory/ttl.js';
import { buildLogger } from './observability/logger.js';
import { createErrorReporter } from './observability/errors.js';
import { createHeartbeatDriver } from './observability/heartbeat.js';
import { createEventBus } from './events/bus.js';
import { runStartupCredentialsCheck } from './agent/credentials.js';
import type { AuthMethod } from './agent/credentials.js';
import { loadSkills } from './skills/loader.js';
import { createSkillRegistry } from './skills/registry.js';
import { createBudgetTracker } from './agent/budget.js';
import { createRateLimitTracker } from './agent/rate-limit-tracker.js';
import { createLiveSessionsTracker } from './observability/live-sessions.js';
import { createAuthChecker } from './telegram/auth.js';
import { createTelegramService } from './telegram/bot.js';
import { createSchedulesRepo } from './db/repositories/schedules.js';
import { createBudgetStateRepo } from './db/repositories/budget-state.js';
import { createVoiceStateRepo } from './db/repositories/voice-state.js';
import { createSchedulerEngine } from './scheduler/engine.js';
import { createDashboard } from './dashboard/server.js';
import type { DispatchDeps } from './agent/dispatch.js';
import type { Logger } from 'pino';
import { dirname } from 'node:path';

async function main(): Promise<void> {
  bootstrapEnv();

  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (e instanceof ConfigLoadError) {
      console.error(`\nandybioticlaw: config error (${e.kind})\n\n${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  let config = loaded.config;
  const dataDir = expandPath(config.service.dataDir, projectRoot());

  ensureDir(dataDir);
  ensureDir(logsDir(dataDir));
  ensureDir(workspacesDir(dataDir));
  ensureDir(resolve(workspacesDir(dataDir), 'groups'));
  const dmWorkspace = resolve(workspacesDir(dataDir), 'dm');
  ensureDir(dmWorkspace);

  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true;
  const logger: Logger = buildLogger({
    level: config.service.logLevel,
    logsDir: logsDir(dataDir),
    pretty,
  });

  logger.info(
    {
      agent: getDefaultAgent(config).name,
      model: getDefaultAgent(config).model,
      configPath: loaded.configPath,
      dataDir,
    },
    `andybioticlaw starting (agent: ${getDefaultAgent(config).name}, model: ${getDefaultAgent(config).model})`,
  );

  // Multi-agent boot summary — make it obvious at startup which agents
  // are configured + how routing is set up. For a single-Emma setup
  // this is one line; for multi-agent it lists each + counts bindings.
  for (const a of config.agents) {
    const flag = a.default ? ' (default)' : '';
    const skills = a.skills.includes('*')
      ? '*'
      : a.skills.length === 0
        ? '(none)'
        : a.skills.join(',');
    const routing = a.routing.enabled
      ? `on(>=${a.routing.minCharsForOpus} chars → Opus)`
      : 'off';
    logger.info(
      {
        agentId: a.id,
        model: a.model,
        haikuModel: a.haikuModel,
        skills: a.skills,
        routingEnabled: a.routing.enabled,
        ...(a.tokenEnvVar ? { tokenEnvVar: a.tokenEnvVar } : {}),
      },
      `agent ${a.id}${flag}  model=${a.model}  skills=[${skills}]  routing=${routing}`,
    );
  }
  logger.info(
    { count: config.bindings.length },
    `bindings: ${config.bindings.length} rule(s)${
      config.bindings.length === 0 ? ' — all messages → default agent' : ''
    }`,
  );

  const bus = createEventBus();
  const errors = createErrorReporter(bus, logger);

  const dbPath = sqliteDbPath(dataDir);
  const dbHandle = openDatabase(dbPath, logger);
  const audit = createAuditRepo(dbHandle.db);
  const heartbeats = createHeartbeatsRepo(dbHandle.db);
  const sessions = createSessionsRepo(dbHandle.db);
  const messages = createMessagesRepo(dbHandle.db);
  const memoryRepo = createMemoryRepo(dbHandle.db);
  const notesRepo = createNotesRepo(dbHandle.db);
  const schedulesRepo = createSchedulesRepo(dbHandle.db);
  const budgetStateRepo = createBudgetStateRepo(dbHandle.db);
  const voiceStateRepo = createVoiceStateRepo(dbHandle.db);

  const orphanResult = sessions.markRunningAsOrphaned();
  if (orphanResult.count > 0) {
    logger.warn(
      { count: orphanResult.count, chatIds: orphanResult.chatIds },
      `marked ${orphanResult.count} interrupted session(s) as orphaned`,
    );
    audit.record({
      kind: 'boot_orphan_sweep',
      actor: 'startup',
      detail: { count: orphanResult.count, chatIds: orphanResult.chatIds },
    });
  }

  // Skill registry (DB-backed enable/disable). Populated by loadSkills.
  const skillRegistry = createSkillRegistry(dbHandle.db);

  // Secrets manager — skill-scope lookups go through the registry, which is
  // refreshed each time we re-scan skills (startup + install/uninstall CLI).
  const secrets = createSecretsManager({
    store: envSecretsStore(),
    skills: liveSkillPermissions(() => skillRegistry.requiredSecretsTable()),
    audit,
  });
  logSecretsAvailability(logger, secrets);

  const reloader = createReloadController(config, bus, logger);
  reloader.installSighupHandler();
  reloader.onReload((next) => {
    config = next;
    logger.level = config.service.logLevel;
  });

  let credentialsOk = false;
  let authMethod: AuthMethod | null = null;
  const credentialsResult = await runStartupCredentialsCheck({
    credentialsDir: getDefaultAgent(config).credentialsDir,
    logger,
    bus,
    audit,
    errors,
  });
  credentialsOk = credentialsResult.ok;
  authMethod = credentialsOk
    ? ((credentialsResult.details?.['authMethod'] as AuthMethod | undefined) ?? null)
    : null;
  bus.on('credentials:status-changed', ({ ok, details }) => {
    credentialsOk = ok;
    authMethod = ok
      ? ((details?.['authMethod'] as AuthMethod | undefined) ?? null)
      : null;
  });

  const skillsDir = expandPath(config.skills.dir, projectRoot());

  function rescanSkills(): void {
    // Drop every current registry entry, then re-scan from disk. Active
    // sessions are unaffected because they captured `activeFor(scope)` at
    // session-start into local variables — they don't re-read the registry
    // mid-turn. Safe to call while the service is serving traffic.
    for (const rec of skillRegistry.list()) {
      skillRegistry.unregister(rec.name);
    }
    const result = loadSkills({ dir: skillsDir, logger, registry: skillRegistry });
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        errors.report({
          kind: 'skill_load_failed',
          message: `skill "${f.name}" failed to load: ${f.error}`,
        });
      }
    }
  }
  rescanSkills();

  // Memory manager + TTL cron (also runs message-retention cleanup).
  const memoryManager = createMemoryManager({ repo: memoryRepo, logger });
  const memoryTtl = createMemoryTtlCron({
    manager: memoryManager,
    repo: memoryRepo,
    sessionsRepo: sessions,
    messagesRepo: messages,
    logger,
    cronExpr: () => config.memory.ttlCleanupCron,
    timezone: config.service.timezone,
    sessionWorkspaceRoot: dmWorkspace,
    messageRetentionDays: () => config.messages.retentionDays,
  });
  memoryTtl.start();

  const rateLimitTracker = createRateLimitTracker();
  const liveSessions = createLiveSessionsTracker();

  const budget = createBudgetTracker(
    sessions,
    () => ({
      dailyTokenLimit: config.budget.dailyTokenLimit,
      perSessionTokenLimit: config.budget.perSessionTokenLimit,
      dailyResetTime: config.budget.dailyResetTime,
      timezone: config.service.timezone,
    }),
    budgetStateRepo,
  );

  let telegramQueueDepths: () => Record<string, number> = () => ({});
  const heartbeat = createHeartbeatDriver({
    repo: heartbeats,
    logger,
    snapshot: () => {
      const depths = telegramQueueDepths();
      const activeSessions = Object.values(depths).reduce((a, b) => a + b, 0);
      return { active_sessions: activeSessions, queue_depths: depths };
    },
    intervalMs: () => config.observability.heartbeatIntervalSec * 1000,
    retentionMs: () => config.observability.heartbeatRetentionDays * 24 * 60 * 60 * 1000,
  });
  heartbeat.start();

  const auth = createAuthChecker(
    () => ({
      dmAllowedUserIds: config.telegram.dm.allowedUserIds,
      groupAllowedGroupIds: config.telegram.group.allowedGroupIds,
    }),
    audit,
    logger,
  );

  const principalUserId = config.telegram.dm.allowedUserIds[0] ?? null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const memoryProposalServer = resolveMemoryServerSpawn();

  // Auto-generate data/policies.json on first boot from the configured
  // principal id. Mirrors today's permissive behaviour for the principal
  // DM (`execMode: 'full'` matches `--permission-mode bypassPermissions`)
  // — operator can tighten via `andybioticlaw policy edit` later. Step 4
  // of the multi-agent refactor wires this file into runtime decisions;
  // until then it's stored but unused.
  const policiesFilePath = policiesPath(dataDir);
  let policies = loadPolicies(policiesFilePath);
  if (!policies) {
    policies = synthesizeDefaultPolicies({
      defaultAgentId: 'emma',
      principalUserId,
    });
    savePolicies(policiesFilePath, policies);
    logger.info(
      { path: policiesFilePath, contexts: Object.keys(policies.contexts).length },
      'auto-generated data/policies.json from current config',
    );
    audit.record({
      kind: 'policies_auto_generated',
      actor: 'startup',
      detail: { path: policiesFilePath, principalUserId },
    });
  }

  let telegram: ReturnType<typeof createTelegramService> | null = null;
  let scheduler: ReturnType<typeof createSchedulerEngine> | null = null;
  // Local-dev escape hatch: set ANDYBIOTICLAW_DISABLE_TELEGRAM=1 to boot
  // everything except the bot. Useful when smoke-testing the dashboard
  // on a laptop with the same .env as a running production VPS — without
  // it, both instances would race to poll /getUpdates and Telegram
  // 409-kicks the loser. NEVER set this in the systemd unit's env.
  const telegramDisabledByEnv =
    process.env.ANDYBIOTICLAW_DISABLE_TELEGRAM === '1';
  if (telegramDisabledByEnv && process.env.NODE_ENV === 'production') {
    // Hard-fail loudly — this flag is a dev convenience and must never
    // accidentally suppress the bot in prod (the systemd unit sets
    // NODE_ENV=production). Easier to surface at boot than to debug
    // a "why isn't Emma answering" hour later.
    logger.error(
      'ANDYBIOTICLAW_DISABLE_TELEGRAM=1 set with NODE_ENV=production — refusing to boot. Unset the env var to start the bot.',
    );
    process.exit(1);
  }
  if (telegramDisabledByEnv) {
    logger.warn(
      'ANDYBIOTICLAW_DISABLE_TELEGRAM=1 — bot disabled by env. Dashboard, CLI, and scheduled jobs still work.',
    );
  } else if (!botToken) {
    logger.warn(
      'TELEGRAM_BOT_TOKEN is unset — bot disabled. Dashboard, CLI, and scheduled jobs still work.',
    );
  } else if (principalUserId === null) {
    logger.warn(
      'telegram.dm.allowedUserIds is empty — bot would have no users. Skipping bot startup.',
    );
  } else {
    telegram = createTelegramService({
      config: {
        botToken,
        timezone: config.service.timezone,
        cwd: dmWorkspace,
        streamEditIntervalMs: () => config.telegram.streamEditIntervalMs,
        longTaskNotifyAfterMs: () => config.telegram.longTaskNotifyAfterMs,
        conversationHistoryLimit: () => config.telegram.conversationHistoryLimit,
        memoryAutoAccept: () => config.memory.autoAccept,
        voiceMaxDurationSec: () => config.telegram.voice.maxDurationSec,
        voiceLanguage: () => config.telegram.voice.language,
        // Per-message agent resolution. Reads `agents:` + `bindings:`
        // off the live `config` capture (refreshed on hot-reload) so a
        // newly-added binding rule routes the very next message.
        resolveAgent: (chatId, userId) => {
          const ctx = resolveBinding(
            { channel: 'telegram', chatId, userId },
            config.bindings,
            config.agents,
          );
          const agent = config.agents.find((a) => a.id === ctx.agentId);
          if (!agent) {
            // Should be unreachable — schema enforces every binding's
            // agentId is real, and resolveBinding falls back to the
            // default agent. Defensive: return the default.
            return getDefaultAgent(config);
          }
          return agent;
        },
      },
      logger,
      audit,
      sessions,
      messages,
      memoryRepo,
      memoryManager,
      skills: skillRegistry,
      auth,
      budget,
      errors,
      credentialsReady: () => credentialsOk,
      principalChatId: principalUserId,
      memoryProposalServer,
      dbPath,
      sessionWorkspaceRoot: dmWorkspace,
      resolveSkillSecret: (skillName, secretName) =>
        secrets.getSecret(secretName, { skill: skillName }),
      // Re-load + resolve on every session so operator edits to
      // policies.json take effect without a service restart. Cheap
      // (small JSON, parsed once per session — same shape as the
      // dashboard route's read-fresh approach).
      resolvePolicy: (contextKey) => {
        const file = loadPolicies(policiesFilePath);
        if (!file) {
          // policies.json was deleted between boot and the session;
          // fall back to the in-memory default we generated at startup.
          return resolvePolicyFn(policies, contextKey);
        }
        return resolvePolicyFn(file, contextKey);
      },
      rateLimitTracker,
      liveSessions,
      voiceState: voiceStateRepo,
    });
    telegramQueueDepths = () => telegram!.queue.depths();

    await telegram.start();

    if (orphanResult.count > 0) {
      await telegram.notifyPrincipal(
        `ℹ️ Service restarted. ${orphanResult.count} session(s) interrupted. You can /retry them once re-identified in the dashboard.`,
      );
    }

    // Scheduler engine. Requires the telegram api + queue; shares the
    // per-chat queue with interactive DMs so schedule-fired agent sessions
    // serialize behind live user conversations.
    scheduler = createSchedulerEngine({
      logger,
      telegramApi: telegram.api,
      schedulesRepo,
      sessionsRepo: sessions,
      audit,
      queue: telegram.queue,
      budget,
      principalChatId: principalUserId,
      timezone: config.service.timezone,
      notifyPrincipal: (text) => telegram!.notifyPrincipal(text),
      buildSchedulerSessionInput: ({ sessionId, chatId, userMessage, scheduleName, modelOverride, signal, contextKey }) => {
        // Parse the schedule's stored context key
        // (`<agentId>:<channel>:<chatId>`) and resolve the agent. If the
        // schedule was created before migration 0009 (context = null), or
        // the referenced agent has been removed since, fall back to the
        // default agent and audit the drift so the operator can fix the
        // schedule (or delete it).
        let scheduleAgent = getDefaultAgent(config);
        if (contextKey) {
          const parsed = contextKey.split(':');
          const agentIdFromCtx = parsed[0];
          if (agentIdFromCtx) {
            const found = config.agents.find((a) => a.id === agentIdFromCtx);
            if (found) {
              scheduleAgent = found;
            } else {
              audit.record({
                kind: 'schedule_agent_unknown',
                actor: 'scheduler',
                detail: {
                  contextKey,
                  scheduleName,
                  fallbackAgentId: scheduleAgent.id,
                },
              });
            }
          }
        }
        return {
          chatId,
          source: 'schedule',
          userMessage,
          principalUserId,
          principalLabel: `scheduler:${scheduleName}`,
          model: modelOverride ?? scheduleAgent.model,
          timezone: config.service.timezone,
          agentName: scheduleAgent.name,
          agentId: scheduleAgent.id,
          agentSkills: scheduleAgent.skills,
          ...(scheduleAgent.systemPromptFile
            ? { agentSystemPromptFile: scheduleAgent.systemPromptFile }
            : {}),
          ...(scheduleAgent.tokenEnvVar
            ? { agentTokenEnvVar: scheduleAgent.tokenEnvVar }
            : {}),
          streamIdleTimeoutMs: scheduleAgent.streamIdleTimeoutSec * 1000,
          cwd: dmWorkspace,
          sessionWorkspaceRoot: dmWorkspace,
          conversationHistoryLimit: config.telegram.conversationHistoryLimit,
          sessionIdOverride: sessionId,
          signal,
          // Placeholder sink — the real one (createSchedulerTelegramSink)
          // is attached by the engine before calling queue.submit.
          sink: { onDelta: () => {}, onEnd: async () => {} },
          dbPath,
          memoryProposalServer,
        };
      },
    });
    scheduler.refresh();

    // Two SIGHUP triggers for the scheduler:
    //   1. config hot-reloaded → refresh (if a relevant field changed).
    //   2. CLI `schedule add/enable/disable/remove` sends SIGHUP to pick up
    //      DB changes — but the reloader only fires onReload listeners when
    //      CONFIG fields changed. A separate SIGHUP handler covers the
    //      DB-only case (reload.ts doesn't know about DB changes).
    reloader.onReload(() => scheduler?.refresh());
    // Re-scan skills on SIGHUP too — CLI `skill install/enable/disable` or
    // dropping new manifests in `skills/<name>/` then SIGHUPing the daemon
    // now picks up changes without a full restart.
    process.on('SIGHUP', () => {
      scheduler?.refresh();
      rescanSkills();
    });

    bus.on('error:reported', (payload) => {
      if (!config.observability.errorsToTelegram) return;
      const chatId = config.observability.errorChatIdOverride ?? principalUserId;
      if (chatId === null) return;
      const text = `⚠️ ${payload.kind}: ${payload.message}${
        payload.context ? `\n\n${JSON.stringify(payload.context, null, 2).slice(0, 800)}` : ''
      }`;
      telegram!
        .notifyPrincipal(text)
        .catch((e: unknown) =>
          logger.debug({ err: (e as Error).message }, 'error-DM forward failed'),
        );
    });
  }

  // Dashboard — always available (even with the bot disabled), only gated
  // on `dashboard.enabled`.
  const dispatchDeps: DispatchDeps | null = telegram
    ? {
        api: telegram.api,
        logger,
        audit,
        sessions,
        messages,
        memoryRepo,
        memoryManager,
        budget,
        errors,
        queue: telegram.queue,
        cwd: dmWorkspace,
        timezone: config.service.timezone,
        memoryAutoAccept: () => config.memory.autoAccept,
        streamEditIntervalMs: () => config.telegram.streamEditIntervalMs,
        longTaskNotifyAfterMs: () => config.telegram.longTaskNotifyAfterMs,
        conversationHistoryLimit: () => config.telegram.conversationHistoryLimit,
        credentialsReady: () => credentialsOk,
        dbPath,
        sessionWorkspaceRoot: dmWorkspace,
        memoryProposalServer,
      }
    : null;

  // Hoisted so the dashboard's /healthz can read it.
  let shuttingDown = false;

  const dashboard = createDashboard({
    currentConfig: () => config,
    logger,
    sessions,
    messages,
    memoryManager,
    notes: notesRepo,
    skills: skillRegistry,
    schedules: schedulesRepo,
    heartbeats,
    audit,
    budget,
    queue: telegram?.queue ?? null,
    dispatch: dispatchDeps,
    principalUserId,
    agentName: getDefaultAgent(config).name,
    model: getDefaultAgent(config).model,
    timezone: config.service.timezone,
    credentialsOk: () => credentialsOk,
    authMethod: () => authMethod,
    logPath: resolve(logsDir(dataDir), 'andybioticlaw.log'),
    frontendDistDir: resolve(projectRoot(), 'web', 'dist'),
    policiesPath: () => policiesFilePath,
    onSchedulesChanged: () => scheduler?.refresh(),
    resolveAgentById: (agentId) =>
      config.agents.find((a) => a.id === agentId) ?? getDefaultAgent(config),
    configPath: loaded.configPath,
    reloadConfig: () => reloader.reload(),
    rateLimitTracker,
    liveSessions,
    botProfile: () => telegram?.profile() ?? null,
    dbPing: () => {
      try {
        dbHandle.db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
    isShuttingDown: () => shuttingDown,
  });
  await dashboard.start();

  const pidPath = pidFilePath(dataDir);
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  logger.debug({ pidPath }, 'wrote pidfile');

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    if (telegram) {
      try {
        await telegram.stop();
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'telegram stop failed');
      }
    }

    const deadline = Date.now() + 30_000;
    while (telegram && telegram.queue.totalDepth() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (telegram && telegram.queue.totalDepth() > 0) {
      logger.warn(
        { remaining: telegram.queue.totalDepth() },
        'sessions still in queue at shutdown deadline — leaving to be marked orphaned on next boot',
      );
    }

    memoryTtl.stop();
    heartbeat.stop();
    if (scheduler) scheduler.stop();
    try {
      await dashboard.stop();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'dashboard stop failed');
    }
    try {
      dbHandle.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'db close failed');
    }
    try {
      unlinkSync(pidPath);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('ready');
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function logSecretsAvailability(
  logger: Logger,
  secrets: ReturnType<typeof createSecretsManager>,
): void {
  const declared = secrets.audit_list();
  const missing = declared
    .filter(({ name }) => process.env[name] === undefined || process.env[name] === '')
    .map((d) => d.name);
  if (missing.length > 0) {
    logger.warn({ missing }, 'some declared secrets are unset — see .env.example');
  } else {
    logger.debug({ count: declared.length }, 'core secrets present');
  }
}

/**
 * Resolve how to spawn the memory-proposal MCP server.
 *   - prod (dist/):   node <path-to-compiled>.js
 *   - dev  (src/):    node <tsx-cli> <path-to-ts-source>
 *
 * Expressed as a full {command, args} pair so downstream code doesn't have
 * to know about the dev/prod distinction.
 */
function resolveMemoryServerSpawn(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const jsPath = resolve(here, 'mcp', 'memory-proposal-server.js');
  const tsPath = resolve(here, 'mcp', 'memory-proposal-server.ts');
  if (existsSync(jsPath)) {
    return { command: process.execPath, args: [jsPath] };
  }
  const tsxCli = resolve(projectRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsPath) && existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, tsPath] };
  }
  throw new Error(
    `memory-proposal MCP server not locatable (checked ${jsPath} and ${tsPath} with tsx at ${tsxCli})`,
  );
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
