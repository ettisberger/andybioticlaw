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
import type { ResolvedPolicy } from '../policies/schema.js';
import { createChatRunner, createQueueManager } from '../agent/queue.js';
import type { RateLimitTracker } from '../agent/rate-limit-tracker.js';
import type { LiveSessionsTracker } from '../observability/live-sessions.js';
import type { VoiceStateRepo } from '../db/repositories/voice-state.js';
import { executeSession } from '../agent/session.js';
import { registerCommands, TELEGRAM_MENU_COMMANDS } from './handlers/commands.js';
import { registerDmHandler } from './handlers/dm.js';
import { registerGroupRejectHandler } from './handlers/group.js';
import { registerMemoryCommands } from './handlers/memory-commands.js';
import { registerMemoryCallbacks } from './handlers/memory-callbacks.js';

export interface BotConfigView {
  botToken: string;
  agentName: string;
  /** Stable agent id (e.g. 'emma'). Threaded onto every session row. */
  agentId: string;
  model: string;
  timezone: string;
  cwd: string;
  allowedTools(): string;
  streamIdleTimeoutMs(): number;
  streamEditIntervalMs(): number;
  longTaskNotifyAfterMs(): number;
  conversationHistoryLimit(): number;
  memoryAutoAccept(): boolean;
  /** Reject voice messages longer than this (seconds). */
  voiceMaxDurationSec(): number;
  /** Language hint for voice transcription; 'auto' lets the model detect. */
  voiceLanguage(): string;
  /** Per-message model chooser for DMs. If absent, `model` is used. */
  chooseModel?(userText: string): string;
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
  /** Resolves per-context policy. When set, the harness writes a
   *  `.claude/settings.json` per session. Optional during the
   *  rollout — when absent, today's `bypassPermissions` behaviour
   *  is preserved. */
  resolvePolicy?: (contextKey: string) => ResolvedPolicy;
  /** Rate-limit tracker — captures CLI `rate_limit_event` payloads for dashboard. */
  rateLimitTracker?: RateLimitTracker;
  /** In-flight session state for the dashboard's live view. */
  liveSessions?: LiveSessionsTracker;
  /** Voice-input feature state (enabled flag, toggleable from the CLI menu). */
  voiceState: VoiceStateRepo;
}

export interface BotProfile {
  /** Telegram user id of the bot itself. */
  id: number;
  username: string | null;
  firstName: string;
  /** Bot avatar image bytes + MIME, or `null` if the bot has no profile photo
   *  (or the fetch failed — failure logs a warning, doesn't crash). */
  avatar: { data: Buffer; contentType: string } | null;
}

export interface TelegramService {
  start(): Promise<void>;
  stop(): Promise<void>;
  notifyPrincipal(text: string): Promise<void>;
  /** Returns the bot's Telegram profile (username, first-name, avatar), or
   *  `null` until the background fetch completes (typically ~1s after start).
   *  Lazily refetched if the cached value is `null`. */
  profile(): BotProfile | null;
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
            ...(deps.rateLimitTracker ? { rateLimitTracker: deps.rateLimitTracker } : {}),
            ...(deps.liveSessions ? { liveSessions: deps.liveSessions } : {}),
            ...(deps.resolvePolicy ? { resolvePolicy: deps.resolvePolicy } : {}),
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
      agentId: deps.config.agentId,
    model: deps.config.model,
    ...(deps.config.chooseModel ? { chooseModel: deps.config.chooseModel } : {}),
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
    voiceState: deps.voiceState,
    voiceMaxDurationSec: () => deps.config.voiceMaxDurationSec(),
    voiceLanguage: () => deps.config.voiceLanguage(),
    botToken: deps.config.botToken,
  });

  registerCommands(bot, {
    sessions: deps.sessions,
    budget: deps.budget,
    audit: deps.audit,
    agentName: deps.config.agentName,
    model: deps.config.model,
    timezone: deps.config.timezone,
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
  let cachedProfile: BotProfile | null = null;
  let profileFetchInFlight: Promise<void> | null = null;

  const fetchProfile = async (): Promise<void> => {
    try {
      const me = await bot.api.getMe();
      let avatar: BotProfile['avatar'] = null;
      try {
        const photos = await bot.api.getUserProfilePhotos(me.id, { limit: 1 });
        const sizes = photos.photos[0];
        if (sizes && sizes.length > 0) {
          // PhotoSize[] is sorted smallest → largest; last entry is highest
          // resolution. We cache a single copy; ~50 KB on typical bots.
          const largest = sizes[sizes.length - 1]!;
          const fileInfo = await bot.api.getFile(largest.file_id);
          if (fileInfo.file_path) {
            const url = `https://api.telegram.org/file/bot${deps.config.botToken}/${fileInfo.file_path}`;
            const res = await fetch(url);
            if (res.ok) {
              const data = Buffer.from(await res.arrayBuffer());
              const contentType =
                res.headers.get('content-type') ?? 'image/jpeg';
              avatar = { data, contentType };
            } else {
              deps.logger.warn(
                { status: res.status },
                'bot avatar download failed (non-fatal)',
              );
            }
          }
        }
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message },
          'bot avatar fetch failed (non-fatal, rendering fallback)',
        );
      }
      cachedProfile = {
        id: me.id,
        username: me.username ?? null,
        firstName: me.first_name,
        avatar,
      };
      deps.logger.info(
        {
          username: cachedProfile.username,
          hasAvatar: avatar !== null,
        },
        'bot profile cached',
      );
    } catch (e) {
      deps.logger.warn(
        { err: (e as Error).message },
        'bot profile fetch failed (non-fatal)',
      );
    } finally {
      profileFetchInFlight = null;
    }
  };

  return {
    async start() {
      if (running) return;
      running = true;
      // Populate Telegram's `/` autocomplete menu with our slash
      // commands. Non-fatal on failure — the commands still work by
      // typing them manually; we just lose the UI hint. Fire-and-forget
      // so bot.start() isn't blocked by a flaky Telegram API moment.
      bot.api
        .setMyCommands(TELEGRAM_MENU_COMMANDS)
        .catch((e) => {
          deps.logger.warn(
            { err: (e as Error).message },
            'setMyCommands failed — slash menu will be empty but commands still work',
          );
        });
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
      // Background fetch — bot.start() never resolves (long-poll), so we
      // kick this off in parallel. Not awaited: dashboard renders a
      // fallback icon until the profile is ready (~1 s typically).
      profileFetchInFlight = fetchProfile();
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
    profile() {
      // Opportunistic re-fetch if we never successfully cached (e.g. the
      // first attempt hit a transient network error). No-op when a fetch
      // is already pending.
      if (cachedProfile === null && profileFetchInFlight === null && running) {
        profileFetchInFlight = fetchProfile();
      }
      return cachedProfile;
    },
    queue,
    api: bot.api,
  };
}
