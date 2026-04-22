import { randomUUID } from 'node:crypto';
import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';
import type { Api } from 'grammy';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import type { MessagesRepo } from '../../db/repositories/messages.js';
import type { AuditRepo } from '../../db/repositories/audit.js';
import type { MemoryRepo } from '../../db/repositories/memory.js';
import type { MemoryManager } from '../../memory/manager.js';
import type { QueueManager } from '../../agent/queue.js';
import { QueueCancelledError } from '../../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../../agent/session.js';
import { createTelegramStreamSink } from '../streaming.js';
import type { BudgetTracker } from '../../agent/budget.js';
import type { AuthChecker } from '../auth.js';
import type { ErrorReporter } from '../../observability/errors.js';

export type TelegramDmSubmit = (ctx: Context, userText: string) => Promise<void>;
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
}

export function registerDmHandler(deps: DmHandlerDeps): TelegramDmSubmit {
  const submit: TelegramDmSubmit = async (ctx, userText) => {
    if (!ctx.chat || ctx.chat.type !== 'private') return;

    const chatIdNum = ctx.chat.id;
    const chatIdStr = String(chatIdNum);

    if (!deps.credentialsReady()) {
      await ctx.reply(
        '⚠️ Agent not ready: Claude credentials are missing. Check the service logs and run `claude login`, then restart the service.',
      );
      return;
    }

    const budgetStatus = deps.budget.status();
    if (budgetStatus.exhausted) {
      await ctx.reply(deps.budget.exhaustedMessage(budgetStatus));
      deps.audit.record({
        kind: 'budget_exceeded',
        actor: chatIdStr,
        detail: { used: budgetStatus.used, limit: budgetStatus.dailyLimit },
      });
      return;
    }

    const sessionId = randomUUID();
    const depthBeforeSubmit = deps.queue.depth(chatIdStr);
    const startsImmediately = depthBeforeSubmit === 0;

    const openingText = startsImmediately
      ? '…'
      : `… (queued, #${depthBeforeSubmit + 1})`;

    let openingMessageId: number;
    try {
      const opening = await ctx.reply(openingText);
      openingMessageId = opening.message_id;
    } catch (e) {
      deps.errors.report({
        kind: 'telegram_send_failed',
        message: `failed to send opening message: ${(e as Error).message}`,
        context: { chatId: chatIdStr },
      });
      return;
    }

    const sink = createTelegramStreamSink(
      {
        api: deps.api,
        chatId: chatIdNum,
        sessionId,
        logger: deps.logger,
        editIntervalMs: deps.streamEditIntervalMs(),
        longTaskNotifyAfterMs: deps.longTaskNotifyAfterMs(),
        proposalProcessor: {
          memoryRepo: deps.memoryRepo,
          audit: deps.audit,
          manager: deps.memoryManager,
          autoAccept: deps.memoryAutoAccept,
        },
      },
      openingMessageId,
    );

    const placeholderController = new AbortController();

    const req: SessionExecuteInput = {
      chatId: chatIdStr,
      source: 'dm',
      userMessage: userText,
      principalUserId: ctx.from?.id ?? deps.principalUserId,
      principalLabel: `Telegram user ${ctx.from?.id ?? '?'}`,
      model: deps.model,
      timezone: deps.timezone,
      agentName: deps.agentName,
      allowedTools: deps.allowedTools(),
      streamIdleTimeoutMs: deps.streamIdleTimeoutMs(),
      cwd: deps.cwd,
      sessionWorkspaceRoot: deps.sessionWorkspaceRoot,
      conversationHistoryLimit: deps.conversationHistoryLimit(),
      sessionIdOverride: sessionId,
      signal: placeholderController.signal,
      sink,
      dbPath: deps.dbPath,
      memoryProposalServer: deps.memoryProposalServer,
    };

    const onStart = () => {
      if (!startsImmediately) {
        deps.api
          .editMessageText(chatIdNum, openingMessageId, '…')
          .catch((e: unknown) =>
            deps.logger.debug(
              { err: (e as Error).message },
              'queued→working edit failed',
            ),
          );
      }
    };

    try {
      await deps.queue.submit(chatIdStr, req, onStart);
    } catch (e) {
      if (e instanceof QueueCancelledError) {
        deps.sessions.update(sessionId, {
          status: 'cancelled',
          ended_at: Date.now(),
          error: 'cancelled before start',
        });
        return;
      }
      deps.errors.report({
        kind: 'dm_submit_error',
        message: `unexpected DM submit error: ${(e as Error).message}`,
        context: { chatId: chatIdStr, sessionId },
      });
      try {
        await ctx.reply(`⚠️ Internal error: ${(e as Error).message}`);
      } catch {
        /* ignore */
      }
    }
  };

  deps.bot.on('message:text', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const text = (ctx.message?.text ?? '').trim();
    if (!text) return;
    if (text.startsWith('/')) return;
    await submit(ctx, text);
  });

  deps.bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (ctx.message?.text !== undefined) return;
    await ctx.reply('I can only handle text messages for now.');
  });

  return submit;
}
