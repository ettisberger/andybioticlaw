import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapEnv, loadConfig, ConfigLoadError, projectRoot } from './config/load.js';
import { createReloadController } from './config/reload.js';
import {
  createSecretsManager,
  envSecretsStore,
  liveSkillPermissions,
} from './config/secrets.js';
import {
  expandPath,
  logsDir,
  sqliteDbPath,
  pidFilePath,
  workspacesDir,
} from './config/paths.js';
import { openDatabase } from './db/index.js';
import { createAuditRepo } from './db/repositories/audit.js';
import { createHeartbeatsRepo } from './db/repositories/heartbeats.js';
import { createSessionsRepo } from './db/repositories/sessions.js';
import { createMessagesRepo } from './db/repositories/messages.js';
import { createMemoryRepo } from './db/repositories/memory.js';
import { createMemoryManager } from './memory/manager.js';
import { createMemoryTtlCron } from './memory/ttl.js';
import { buildLogger } from './observability/logger.js';
import { createErrorReporter } from './observability/errors.js';
import { createHeartbeatDriver } from './observability/heartbeat.js';
import { createEventBus } from './events/bus.js';
import { runStartupCredentialsCheck } from './agent/credentials.js';
import { loadSkills } from './skills/loader.js';
import { createSkillRegistry } from './skills/registry.js';
import { createBudgetTracker } from './agent/budget.js';
import { createRateLimitTracker } from './agent/rate-limit-tracker.js';
import { createAuthChecker } from './telegram/auth.js';
import { createTelegramService } from './telegram/bot.js';
import { createSchedulesRepo } from './db/repositories/schedules.js';
import { createBudgetStateRepo } from './db/repositories/budget-state.js';
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
      agent: config.agent.name,
      model: config.agent.model,
      configPath: loaded.configPath,
      dataDir,
    },
    `andybioticlaw starting (agent: ${config.agent.name}, model: ${config.agent.model})`,
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
  const schedulesRepo = createSchedulesRepo(dbHandle.db);
  const budgetStateRepo = createBudgetStateRepo(dbHandle.db);

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
  const credentialsResult = await runStartupCredentialsCheck({
    credentialsDir: config.agent.credentialsDir,
    logger,
    bus,
    audit,
    errors,
  });
  credentialsOk = credentialsResult.ok;
  bus.on('credentials:status-changed', ({ ok }) => {
    credentialsOk = ok;
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

  let telegram: ReturnType<typeof createTelegramService> | null = null;
  let scheduler: ReturnType<typeof createSchedulerEngine> | null = null;
  if (!botToken) {
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
        agentName: config.agent.name,
        model: config.agent.model,
        timezone: config.service.timezone,
        cwd: dmWorkspace,
        allowedTools: () => config.agent.allowedTools,
        streamIdleTimeoutMs: () => config.agent.streamIdleTimeoutSec * 1000,
        streamEditIntervalMs: () => config.telegram.streamEditIntervalMs,
        longTaskNotifyAfterMs: () => config.telegram.longTaskNotifyAfterMs,
        conversationHistoryLimit: () => config.telegram.conversationHistoryLimit,
        memoryAutoAccept: () => config.memory.autoAccept,
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
      rateLimitTracker,
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
      buildSchedulerSessionInput: ({ sessionId, chatId, userMessage, scheduleName, modelOverride, signal }) => ({
        chatId,
        source: 'schedule',
        userMessage,
        principalUserId,
        principalLabel: `scheduler:${scheduleName}`,
        model: modelOverride ?? config.agent.model,
        timezone: config.service.timezone,
        agentName: config.agent.name,
        allowedTools: config.agent.allowedTools,
        streamIdleTimeoutMs: config.agent.streamIdleTimeoutSec * 1000,
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
      }),
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
        agentName: config.agent.name,
        model: config.agent.model,
        timezone: config.service.timezone,
        memoryAutoAccept: () => config.memory.autoAccept,
        streamIdleTimeoutMs: () => config.agent.streamIdleTimeoutSec * 1000,
        streamEditIntervalMs: () => config.telegram.streamEditIntervalMs,
        longTaskNotifyAfterMs: () => config.telegram.longTaskNotifyAfterMs,
        conversationHistoryLimit: () => config.telegram.conversationHistoryLimit,
        allowedTools: () => config.agent.allowedTools,
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
    skills: skillRegistry,
    schedules: schedulesRepo,
    heartbeats,
    audit,
    budget,
    queue: telegram?.queue ?? null,
    dispatch: dispatchDeps,
    principalUserId,
    agentName: config.agent.name,
    model: config.agent.model,
    timezone: config.service.timezone,
    credentialsOk: () => credentialsOk,
    logPath: resolve(logsDir(dataDir), 'andybioticlaw.log'),
    frontendDistDir: resolve(projectRoot(), 'web', 'dist'),
    onSchedulesChanged: () => scheduler?.refresh(),
    rateLimitTracker,
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
