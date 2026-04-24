import type { Bot, Context } from 'grammy';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { AuditRepo } from '../../db/repositories/audit.js';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import type { MessagesRepo } from '../../db/repositories/messages.js';
import type { MemoryRepo } from '../../db/repositories/memory.js';
import type { MemoryManager } from '../../memory/manager.js';
import type { BudgetTracker } from '../../agent/budget.js';
import type { AuthChecker } from '../auth.js';
import type { ErrorReporter } from '../../observability/errors.js';
import type { QueueManager } from '../../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../../agent/session.js';
import { dispatchUserPrompt } from '../../agent/dispatch.js';
import type { DispatchDeps } from '../../agent/dispatch.js';
import type { VoiceStateRepo } from '../../db/repositories/voice-state.js';
import { downloadVoiceMessage, transcribeWithGroq } from '../voice.js';

export interface TelegramSubmitOptions {
  /** Set when this prompt is a `/retry` of a prior session — audit row
   *  gets `origin: "telegram-retry"` and `retryOfSessionId`. */
  retryOfSessionId?: string;
}

export type TelegramDmSubmit = (
  ctx: Context,
  userText: string,
  opts?: TelegramSubmitOptions,
) => Promise<void>;
export type TelegramCancel = (
  chatId: string,
) => Promise<{ cancelledCurrent: boolean; droppedQueued: number }>;

export interface DmHandlerDeps {
  bot: Bot;
  api: Api;
  logger: Logger;
  audit: AuditRepo;
  sessions: SessionsRepo;
  messages: MessagesRepo;
  memoryRepo: MemoryRepo;
  memoryManager: MemoryManager;
  auth: AuthChecker;
  budget: BudgetTracker;
  errors: ErrorReporter;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult>;
  cwd: string;
  agentName: string;
  model: string;
  timezone: string;
  principalUserId: number | null;
  memoryAutoAccept: () => boolean;
  streamIdleTimeoutMs: () => number;
  streamEditIntervalMs: () => number;
  longTaskNotifyAfterMs: () => number;
  conversationHistoryLimit: () => number;
  allowedTools: () => string;
  credentialsReady: () => boolean;
  dbPath: string;
  sessionWorkspaceRoot: string;
  memoryProposalServer: { command: string; args: string[] };
  /** Voice-input feature state (enabled flag + audit timestamp). */
  voiceState: VoiceStateRepo;
  /** Reject voice messages longer than this (seconds). */
  voiceMaxDurationSec: () => number;
  /** Groq Whisper language hint; `'auto'` lets the model detect. */
  voiceLanguage: () => string;
  /** Telegram bot token (needed for the file-download URL). */
  botToken: string;
}

function dispatchDepsFromHandler(deps: DmHandlerDeps): DispatchDeps {
  return {
    api: deps.api,
    logger: deps.logger,
    audit: deps.audit,
    sessions: deps.sessions,
    messages: deps.messages,
    memoryRepo: deps.memoryRepo,
    memoryManager: deps.memoryManager,
    budget: deps.budget,
    errors: deps.errors,
    queue: deps.queue,
    cwd: deps.cwd,
    agentName: deps.agentName,
    model: deps.model,
    timezone: deps.timezone,
    memoryAutoAccept: deps.memoryAutoAccept,
    streamIdleTimeoutMs: deps.streamIdleTimeoutMs,
    streamEditIntervalMs: deps.streamEditIntervalMs,
    longTaskNotifyAfterMs: deps.longTaskNotifyAfterMs,
    conversationHistoryLimit: deps.conversationHistoryLimit,
    allowedTools: deps.allowedTools,
    credentialsReady: deps.credentialsReady,
    dbPath: deps.dbPath,
    sessionWorkspaceRoot: deps.sessionWorkspaceRoot,
    memoryProposalServer: deps.memoryProposalServer,
  };
}

export function registerDmHandler(deps: DmHandlerDeps): TelegramDmSubmit {
  const dispatchDeps = dispatchDepsFromHandler(deps);

  const submit: TelegramDmSubmit = async (ctx, userText, opts) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return;

    const outcome = await dispatchUserPrompt(
      {
        chatId: ctx.chat.id,
        userText,
        fromUserId: ctx.from?.id ?? null,
        origin: opts?.retryOfSessionId ? 'telegram-retry' : 'telegram-dm',
        ...(opts?.retryOfSessionId ? { retryOfSessionId: opts.retryOfSessionId } : {}),
      },
      dispatchDeps,
      deps.principalUserId,
    );

    if (outcome.kind === 'refused') {
      try {
        await ctx.reply(outcome.userMessage);
      } catch {
        /* ignore */
      }
    }
  };

  // grammY middleware: handlers fire in registration order and each must
  // call `next()` to forward, otherwise the chain stops. This DM catch-all
  // is registered BEFORE the `bot.command('start')` handlers, so anything
  // we don't handle here MUST be forwarded via `next()` or commands get
  // silently swallowed. (This exact bug landed during the dispatch-refactor
  // and survived until Station 4 of the end-to-end verification.)
  deps.bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      // Not a DM — let other middleware (group reject) take it.
      await next();
      return;
    }
    const text = (ctx.message?.text ?? '').trim();
    if (!text) {
      await next();
      return;
    }
    if (text.startsWith('/')) {
      // Slash command — hand off to the command handlers (/start, /help,
      // /status, /cancel, /retry, /remember, /memory, /forget).
      await next();
      return;
    }
    await submit(ctx, text);
  });

  // Voice-message pre-processor. Runs before the non-text reject below
  // so voice messages get transcribed via Groq Whisper and fed into the
  // normal text-DM path. The feature is gated by two things:
  //   (a) `voiceState.enabled` (operator toggle in the CLI menu — hot,
  //       no restart needed)
  //   (b) `GROQ_API_KEY` in process.env (operator paste in the same
  //       menu; requires a restart to pick up)
  // Either missing → polite refusal. Duration cap rejects before we
  // even download. Any error from download or transcription surfaces
  // verbatim so the operator can diagnose Groq rate-limit / auth / etc.
  deps.bot.on('message:voice', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await next();
      return;
    }
    const voice = ctx.message?.voice;
    if (!voice) {
      await next();
      return;
    }

    if (!deps.voiceState.getEnabled()) {
      await ctx.reply(
        '🎙 Voice input is currently disabled. Send a text message, or enable voice from the CLI menu.',
      );
      return;
    }
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      await ctx.reply(
        '🎙 Voice input is enabled but no GROQ_API_KEY is configured on the server. Set one via the CLI menu and restart the service.',
      );
      return;
    }
    const maxDuration = deps.voiceMaxDurationSec();
    if ((voice.duration ?? 0) > maxDuration) {
      await ctx.reply(
        `🎙 Voice message is too long (${voice.duration}s > ${maxDuration}s cap). Send a shorter clip or raise telegram.voice.maxDurationSec in config.yaml.`,
      );
      return;
    }

    // Best-effort "recording" indicator — signals "I heard your voice
    // and I'm working on it". Ignored if Telegram hiccups.
    void ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});

    try {
      const audio = await downloadVoiceMessage(
        deps.api,
        voice.file_id,
        deps.botToken,
      );
      const { text } = await transcribeWithGroq(audio, {
        apiKey,
        language: deps.voiceLanguage(),
      });
      if (!text) {
        await ctx.reply(
          "🎙 I couldn't make out any words in that clip. Try again in a quieter spot?",
        );
        return;
      }
      // Prefix the text so Emma knows the channel was voice (useful for
      // her to tailor tone — e.g. briefer replies when the user is
      // on-the-go). The prefix is visible to her but NOT re-echoed to
      // the user; the user just sees Emma's response.
      deps.logger.info(
        { chatId: ctx.chat.id, duration: voice.duration, chars: text.length },
        'voice transcribed',
      );
      await submit(ctx, `[🎙 voice] ${text}`);
    } catch (e) {
      deps.logger.warn(
        { err: (e as Error).message, chatId: ctx.chat.id },
        'voice transcription failed',
      );
      await ctx.reply(`🎙 Couldn't transcribe that: ${(e as Error).message}`);
    }
  });

  deps.bot.on('message', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      // Non-private non-text → let group reject handle it.
      await next();
      return;
    }
    if (ctx.message?.text !== undefined) {
      // Text messages are the message:text handler's business AND the
      // bot.command(...) handlers' business — forward so the command
      // middlewares (/start, /help, …) still get their turn. Forgetting
      // `next()` here caused a regression where slash commands got
      // silently swallowed.
      await next();
      return;
    }
    if (ctx.message?.voice !== undefined) {
      // Already handled by the message:voice middleware above — don't
      // fall through to the generic "text only" refusal.
      return;
    }
    // Non-text (photo, sticker, …) in a DM → tell the user we don't
    // handle it. Nothing downstream cares about this kind of update,
    // so we don't need to forward.
    await ctx.reply('I can only handle text and voice messages for now.');
  });

  return submit;
}
