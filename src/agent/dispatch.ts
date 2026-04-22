import { randomUUID } from 'node:crypto';
import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { SessionsRepo } from '../db/repositories/sessions.js';
import type { MessagesRepo } from '../db/repositories/messages.js';
import type { MemoryRepo } from '../db/repositories/memory.js';
import type { MemoryManager } from '../memory/manager.js';
import type { BudgetTracker } from './budget.js';
import type { ErrorReporter } from '../observability/errors.js';
import type { QueueManager } from './queue.js';
import type { SessionExecuteInput, SessionExecuteResult } from './session.js';
import { QueueCancelledError } from './queue.js';
import { createTelegramStreamSink } from '../telegram/streaming.js';

export interface DispatchDeps {
  api: Api;
  logger: Logger;
  audit: AuditRepo;
  sessions: SessionsRepo;
  messages: MessagesRepo;
  memoryRepo: MemoryRepo;
  memoryManager: MemoryManager;
  budget: BudgetTracker;
  errors: ErrorReporter;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult>;
  cwd: string;
  agentName: string;
  model: string;
  timezone: string;
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

export interface DispatchRequest {
  /** Target Telegram chat id (numeric). */
  chatId: number;
  /** User-visible prompt text. */
  userText: string;
  /** Telegram user id of whoever triggered this — null if from a non-Telegram
   *  surface (e.g. the dashboard retry endpoint). Defaults to the first
   *  configured principal when null. */
  fromUserId: number | null;
  /** Origin label for logs + session rows. */
  origin: 'telegram-dm' | 'dashboard-retry' | 'retry-cli';
  /** If this is a retry of a prior session, its id — captured in session row. */
  retryOfSessionId?: string;
}

export type DispatchOutcome =
  | { kind: 'sent'; sessionId: string }
  | { kind: 'refused'; reason: string; userMessage: string };

/**
 * Shared user-prompt dispatcher: sends the opening "…" message, builds the
 * stream sink, constructs a SessionExecuteInput, and submits it to the
 * per-chat queue. Does NOT depend on a grammy Context, so both the Telegram
 * DM handler and the dashboard retry endpoint can use it.
 */
export async function dispatchUserPrompt(
  req: DispatchRequest,
  deps: DispatchDeps,
  principalUserId: number | null,
): Promise<DispatchOutcome> {
  const chatIdStr = String(req.chatId);

  if (!deps.credentialsReady()) {
    return {
      kind: 'refused',
      reason: 'credentials_missing',
      userMessage:
        '⚠️ Agent not ready: Claude credentials are missing. Check the service logs and run `claude login`, then restart the service.',
    };
  }

  const budgetStatus = deps.budget.status();
  if (budgetStatus.exhausted) {
    deps.audit.record({
      kind: 'budget_exceeded',
      actor: chatIdStr,
      detail: { used: budgetStatus.used, limit: budgetStatus.dailyLimit, origin: req.origin },
    });
    return {
      kind: 'refused',
      reason: 'budget_exhausted',
      userMessage: deps.budget.exhaustedMessage(budgetStatus),
    };
  }

  const sessionId = randomUUID();
  const depthBeforeSubmit = deps.queue.depth(chatIdStr);
  const startsImmediately = depthBeforeSubmit === 0;

  const openingText = startsImmediately
    ? '…'
    : `… (queued, #${depthBeforeSubmit + 1})`;

  let openingMessageId: number;
  try {
    const msg = await deps.api.sendMessage(req.chatId, openingText);
    openingMessageId = msg.message_id;
  } catch (e) {
    deps.errors.report({
      kind: 'telegram_send_failed',
      message: `failed to send opening message: ${(e as Error).message}`,
      context: { chatId: chatIdStr, origin: req.origin },
    });
    return {
      kind: 'refused',
      reason: 'opening_send_failed',
      userMessage: `⚠️ Could not send opening message: ${(e as Error).message}`,
    };
  }

  const sink = createTelegramStreamSink(
    {
      api: deps.api,
      chatId: req.chatId,
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
  const input: SessionExecuteInput = {
    chatId: chatIdStr,
    source: 'dm',
    userMessage: req.userText,
    principalUserId: req.fromUserId ?? principalUserId,
    principalLabel: req.fromUserId
      ? `Telegram user ${req.fromUserId}`
      : `${req.origin} (principal)`,
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
        .editMessageText(req.chatId, openingMessageId, '…')
        .catch((e: unknown) =>
          deps.logger.debug(
            { err: (e as Error).message },
            'queued→working edit failed',
          ),
        );
    }
  };

  // Fire-and-forget: the queue schedules the run. The caller doesn't await
  // the session's completion — the sink handles user-visible output.
  deps.queue.submit(chatIdStr, input, onStart).catch((e) => {
    if (e instanceof QueueCancelledError) {
      deps.sessions.update(sessionId, {
        status: 'cancelled',
        ended_at: Date.now(),
        error: 'cancelled before start',
      });
      return;
    }
    deps.errors.report({
      kind: 'dispatch_submit_error',
      message: `submit error: ${(e as Error).message}`,
      context: { chatId: chatIdStr, sessionId, origin: req.origin },
    });
    deps.api
      .sendMessage(req.chatId, `⚠️ Internal error: ${(e as Error).message}`)
      .catch(() => {
        /* best-effort */
      });
  });

  deps.audit.record({
    kind: 'prompt_dispatched',
    actor: req.fromUserId !== null ? `tg:${req.fromUserId}` : `api:${req.origin}`,
    detail: {
      sessionId,
      chatId: chatIdStr,
      origin: req.origin,
      ...(req.retryOfSessionId ? { retryOfSessionId: req.retryOfSessionId } : {}),
    },
  });

  return { kind: 'sent', sessionId };
}
