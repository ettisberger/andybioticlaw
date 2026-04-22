import { Bot } from 'grammy';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { SessionsRepo } from '../db/repositories/sessions.js';
import type { MessagesRepo } from '../db/repositories/messages.js';
import type { MemoryRepo } from '../db/repositories/memory.js';
import type { MemoryManager } from '../memory/manager.js';
import type { BudgetTracker } from '../agent/budget.js';
import type { AuthChecker } from './auth.js';
import type { ErrorReporter } from '../observability/errors.js';
import type { QueueManager } from '../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../agent/session.js';
import type { SkillRegistry } from '../skills/registry.js';
import { createChatRunner, createQueueManager } from '../agent/queue.js';
import { executeSession } from '../agent/session.js';
import { registerCommands } from './handlers/commands.js';
import { registerDmHandler } from './handlers/dm.js';
import { registerGroupRejectHandler } from './handlers/group.js';
import { registerMemoryCommands } from './handlers/memory-commands.js';
import { registerMemoryCallbacks } from './handlers/memory-callbacks.js';

export interface BotConfigView {
  botToken: string;
  agentName: string;
  model: string;
  timezone: string;
  cwd: string;
  allowedTools(): string;
  streamIdleTimeoutMs(): number;
  streamEditIntervalMs(): number;
  longTaskNotifyAfterMs(): number;
  conversationHistoryLimit(): number;
  memoryAutoAccept(): boolean;
}

export interface BotDeps {
  config: BotConfigView;
  logger: Logger;
  audit: AuditRepo;
  sessions: SessionsRepo;
  messages: MessagesRepo;
  memoryRepo: MemoryRepo;
  memoryManager: MemoryManager;
  skills: SkillRegistry;
  auth: AuthChecker;
  budget: BudgetTracker;
  errors: ErrorReporter;
  credentialsReady: () => boolean;
  principalChatId: number | null;
  /** How to spawn the memory-proposal MCP server (dev: tsx, prod: node). */
  memoryProposalServer: { command: string; args: string[] };
  /** Absolute path to the SQLite DB (the MCP server also opens it). */
  dbPath: string;
  /** Root dir for per-session artifacts (each session gets a subdir). */
  sessionWorkspaceRoot: string;
  /** Resolves a skill's scoped secret. Throws if out of scope (audited). */
  resolveSkillSecret: (skillName: string, secretName: string) => string | undefined;
}

export interface TelegramService {
  start(): Promise<void>;
  stop(): Promise<void>;
  notifyPrincipal(text: string): Promise<void>;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult>;
  /** Exposed so scheduler + other internals can send arbitrary messages. */
  api: Api;
}

export function createTelegramService(deps: BotDeps): TelegramService {
  const bot = new Bot(deps.config.botToken);

  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return;
    const decision = deps.auth.check({
      chatType: chat.type,
      chatId: chat.id,
      userId: ctx.from?.id,
    });
    if (decision.kind === 'allow-dm') {
      await next();
      return;
    }
    if (decision.kind === 'reject-dm') {
      try {
        await ctx.reply('🚫 Not authorized.');
      } catch {
        /* ignore */
      }
      return;
    }
    await next();
  });

  const queue = createQueueManager<SessionExecuteInput, SessionExecuteResult>({
    logger: deps.logger,
    makeRunner: (chatId) =>
      createChatRunner<SessionExecuteInput, SessionExecuteResult>({
        chatId,
        logger: deps.logger,
        run: async (req, signal) => {
          const execReq: SessionExecuteInput = { ...req, signal };
          return executeSession(execReq, {
            sessions: deps.sessions,
            messages: deps.messages,
            audit: deps.audit,
            memoryRepo: deps.memoryRepo,
            memoryManager: deps.memoryManager,
            skills: deps.skills,
            resolveSkillSecret: deps.resolveSkillSecret,
            logger: deps.logger,
          });
        },
        onDrop: (req) => {
          bot.api
            .sendMessage(
              Number(req.chatId),
              '⏹ Dropped queued message before it started.',
            )
            .catch(() => {
              /* ignore */
            });
          if (req.sessionIdOverride) {
            deps.sessions.update(req.sessionIdOverride, {
              status: 'cancelled',
              ended_at: Date.now(),
              error: 'cancelled while queued',
            });
          }
        },
      }),
  });

  registerMemoryCallbacks({
    bot,
    memoryRepo: deps.memoryRepo,
    audit: deps.audit,
    manager: deps.memoryManager,
    logger: deps.logger,
  });

  const submit = registerDmHandler({
    bot,
    api: bot.api,
    logger: deps.logger,
    audit: deps.audit,
    sessions: deps.sessions,
    messages: deps.messages,
    memoryRepo: deps.memoryRepo,
    memoryManager: deps.memoryManager,
    auth: deps.auth,
    budget: deps.budget,
    errors: deps.errors,
    queue,
    cwd: deps.config.cwd,
    agentName: deps.config.agentName,
    model: deps.config.model,
    timezone: deps.config.timezone,
    principalUserId: deps.principalChatId,
    memoryAutoAccept: () => deps.config.memoryAutoAccept(),
    streamIdleTimeoutMs: () => deps.config.streamIdleTimeoutMs(),
    streamEditIntervalMs: () => deps.config.streamEditIntervalMs(),
    longTaskNotifyAfterMs: () => deps.config.longTaskNotifyAfterMs(),
    conversationHistoryLimit: () => deps.config.conversationHistoryLimit(),
    allowedTools: () => deps.config.allowedTools(),
    credentialsReady: deps.credentialsReady,
    dbPath: deps.dbPath,
    sessionWorkspaceRoot: deps.sessionWorkspaceRoot,
    memoryProposalServer: deps.memoryProposalServer,
  });

  registerCommands(bot, {
    sessions: deps.sessions,
    budget: deps.budget,
    agentName: deps.config.agentName,
    model: deps.config.model,
    logger: deps.logger,
    submit,
    cancel: async (chatId) => queue.cancel(chatId),
  });

  registerMemoryCommands({
    bot,
    manager: deps.memoryManager,
    audit: deps.audit,
    logger: deps.logger,
    principalUserId: deps.principalChatId,
  });

  registerGroupRejectHandler(bot, deps.audit, deps.logger);

  bot.catch((err) => {
    deps.logger.error({ err: err.error }, 'telegram middleware error');
    deps.errors.report({
      kind: 'telegram_middleware_error',
      message: String(err.error),
    });
  });

  let running = false;

  return {
    async start() {
      if (running) return;
      running = true;
      void bot
        .start({
          drop_pending_updates: false,
          onStart: () => deps.logger.info('telegram bot polling started'),
        })
        .catch((e) => {
          running = false;
          deps.errors.report({
            kind: 'telegram_poll_failed',
            message: `bot polling error: ${(e as Error).message}`,
          });
        });
    },
    async stop() {
      if (!running) return;
      running = false;
      await bot.stop();
    },
    async notifyPrincipal(text: string) {
      if (deps.principalChatId === null) {
        deps.logger.warn({ text }, 'notifyPrincipal: no principal chat id configured');
        return;
      }
      try {
        await bot.api.sendMessage(deps.principalChatId, text);
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message },
          'notifyPrincipal: sendMessage failed',
        );
      }
    },
    queue,
    api: bot.api,
  };
}
