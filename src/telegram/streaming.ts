import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { StreamSink, SessionExecuteResult } from '../agent/session.js';
import type { ProposalPostProcessDeps } from '../memory/proposals.js';
import { processSessionProposals } from '../memory/proposals.js';

export interface StreamSinkDeps {
  api: Api;
  chatId: number;
  sessionId: string;
  logger: Logger;
  editIntervalMs: number;
  /** ms after the initial "Working…" without a delta → show "Still working…". */
  longTaskNotifyAfterMs: number;
  /** Max edits in a rolling 60s window. Default 18 (Telegram caps at 20). */
  rateLimitEditsPer60s?: number;
  /** Post-session memory-proposal handler (Phase 3). If omitted, skipped. */
  proposalProcessor?: Omit<ProposalPostProcessDeps, 'api' | 'logger'>;
  /**
   * Telegram `parse_mode` to apply to FINALIZED edits only — the truly-final
   * edit at session end AND the pre-continuation finalize when a message
   * overflows. Mid-stream edits stay plain text so unclosed tags don't make
   * Telegram reject the edit. On 400 "can't parse entities" we retry once
   * without parse_mode so a malformed tag loses formatting but not content.
   */
  parseMode?: 'HTML';
}

const MAX_MESSAGE_CHARS = 3900; // < Telegram's 4096 hard cap.

/**
 * Build a `StreamSink` that edits a pre-existing Telegram message with
 * batched deltas. The caller has already sent the opening "…" message
 * and passes its message_id here.
 *
 * Responsibilities:
 *   - Batch text deltas and edit the current Telegram message every
 *     `editIntervalMs` ms, subject to a rolling edit-rate-limiter.
 *   - When the current message would exceed ~3900 chars, finalize it (no
 *     suffix) and open a continuation message.
 *   - Send `chatAction: 'typing'` every 5s.
 *   - If `longTaskNotifyAfterMs` ms pass with no delta, edit the opener
 *     to `… (still thinking)`.
 *   - On end (success/failure/cancel), perform a final un-throttled edit
 *     with the complete text, prepending an error line when applicable.
 *
 * Database persistence of the final assistant text happens in
 * `session.executeSession` — this sink doesn't write to the DB.
 */
export function createTelegramStreamSink(
  deps: StreamSinkDeps,
  openingMessageId: number,
): StreamSink {
  const rateLimiter = new RollingRateLimiter(deps.rateLimitEditsPer60s ?? 18, 60_000);

  let currentMessageId = openingMessageId;
  /** The text content currently shown in `currentMessageId`. */
  let currentMessageText = '';
  /** New text streamed since the last edit of `currentMessageId`. */
  let pendingTail = '';
  let totalText = '';

  let deltaReceived = false;
  let ended = false;
  const startedAt = Date.now();

  const typingInterval = setInterval(() => {
    if (ended) return;
    deps.api
      .sendChatAction(deps.chatId, 'typing')
      .catch((e: unknown) =>
        deps.logger.debug({ err: (e as Error).message }, 'typing action failed'),
      );
  }, 5_000);
  typingInterval.unref();

  const flushInterval = setInterval(() => {
    if (ended) return;
    void flush({ final: false });
  }, deps.editIntervalMs);
  flushInterval.unref();

  const longTaskTimer = setTimeout(() => {
    if (ended || deltaReceived) return;
    deps.api
      .editMessageText(
        deps.chatId,
        currentMessageId,
        '… (still thinking)',
      )
      .catch((e: unknown) =>
        deps.logger.debug(
          { err: (e as Error).message },
          'long-task notification edit failed',
        ),
      );
  }, deps.longTaskNotifyAfterMs);
  longTaskTimer.unref();

  /**
   * `flush()` may be called from the periodic setInterval while a prior
   * flush is still awaiting the Telegram API. Two races to avoid:
   *
   * 1. **Delta loss.** `onDelta` appends to `pendingTail` synchronously, but
   *    `flush` awaits `editMessageText`. Any delta that arrives during the
   *    await must NOT be wiped by the post-await reset. Fix: snapshot the
   *    tail at the start of flush, and after the edit succeeds only slice
   *    off exactly the bytes we flushed (`pendingTail = pendingTail.slice(snapshot.length)`).
   *
   * 2. **Overlapping flushes.** Two concurrent edits would race on
   *    `currentMessageText`. Fix: an `inflight` guard serializes flushes;
   *    the non-final path returns early, the final path waits.
   */
  let inflight: Promise<void> | null = null;

  async function flush(opts: { final: boolean; errorPrefix?: string }): Promise<void> {
    if (inflight) {
      if (opts.final) await inflight;
      else return;
    }
    inflight = doFlush(opts);
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  async function doFlush(opts: { final: boolean; errorPrefix?: string }): Promise<void> {
    // Snapshot exactly what we'll send in this cycle.
    const tailSnapshot = pendingTail;
    if (!opts.final && !opts.errorPrefix && !tailSnapshot) return;

    const aboutToShow = currentMessageText + tailSnapshot;

    // Continuation branch — current message would blow Telegram's per-message cap.
    if (aboutToShow.length > MAX_MESSAGE_CHARS) {
      const truncated = aboutToShow.slice(0, MAX_MESSAGE_CHARS);
      // This message is done being edited — apply parse_mode so any HTML in it
      // renders. Continuation message stays plain-text until IT finalizes.
      await editFinalized(deps, currentMessageId, truncated, 'pre-continuation finalize');
      rateLimiter.record();

      const leftover = aboutToShow.slice(MAX_MESSAGE_CHARS);
      try {
        const msg = await deps.api.sendMessage(
          deps.chatId,
          leftover || '… (continued)',
        );
        currentMessageId = msg.message_id;
        currentMessageText = leftover;
        pendingTail = pendingTail.slice(tailSnapshot.length);
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message },
          'telegram continuation send failed',
        );
      }
      return;
    }

    // Normal edit. No mid-stream suffix — Telegram's typing indicator
    // (sent every 5s) is the "still writing" signal.
    let body: string;
    if (opts.errorPrefix) {
      body = `${opts.errorPrefix}\n\n${aboutToShow}`.slice(0, 4096);
    } else {
      body = aboutToShow;
    }

    if (!opts.final && !opts.errorPrefix && !rateLimiter.canAcquire()) {
      // Skip this tick; keep the snapshot in pendingTail for the next one.
      return;
    }

    // Apply parse_mode ONLY on the truly-final edit. Mid-stream edits stay
    // plain so a partial tag (`<b>Meet` — close tag still buffered) doesn't
    // make Telegram reject the edit. errorPrefix also stays plain because
    // we don't want to compound a failed session with a parse error.
    const applyParseMode = opts.final && !opts.errorPrefix;

    try {
      await deps.api.editMessageText(
        deps.chatId,
        currentMessageId,
        body,
        applyParseMode && deps.parseMode ? { parse_mode: deps.parseMode } : {},
      );
      rateLimiter.record();
      currentMessageText = aboutToShow;
      // Only remove the bytes we actually flushed — preserves any deltas
      // appended to pendingTail during the await above.
      pendingTail = pendingTail.slice(tailSnapshot.length);
    } catch (e) {
      const msg = (e as Error).message;
      if (/message is not modified/i.test(msg)) {
        // Content already matches server-side; advance local state as if
        // the edit succeeded (prevents re-submitting the same body forever).
        currentMessageText = aboutToShow;
        pendingTail = pendingTail.slice(tailSnapshot.length);
      } else if (applyParseMode && deps.parseMode && isParseEntitiesError(msg)) {
        // Malformed HTML in the agent output. Resend as plain text so the
        // user at least sees the content; the tags land as literal `<b>…`
        // but that's strictly better than the whole reply vanishing.
        deps.logger.warn(
          { err: msg, parseMode: deps.parseMode },
          'telegram parse_mode rejected; resending plain',
        );
        try {
          await deps.api.editMessageText(deps.chatId, currentMessageId, body);
          currentMessageText = aboutToShow;
          pendingTail = pendingTail.slice(tailSnapshot.length);
        } catch (e2) {
          logTelegramEditFail(deps.logger, e2, currentMessageId, 'plain-text fallback');
        }
      } else {
        // Other errors — keep pendingTail intact so the next tick retries
        // with the full growing content.
        logTelegramEditFail(deps.logger, e, currentMessageId, 'mid-stream edit');
      }
    }
  }

  return {
    onDelta(text: string) {
      if (ended || !text) return;
      deltaReceived = true;
      pendingTail += text;
      totalText += text;
    },

    async onEnd(result: SessionExecuteResult) {
      ended = true;
      clearInterval(typingInterval);
      clearInterval(flushInterval);
      clearTimeout(longTaskTimer);

      let errorPrefix: string | undefined;
      if (result.status === 'failed') {
        const exitSuffix =
          result.exitCode != null && result.exitCode !== 0
            ? ` (exit ${result.exitCode})`
            : '';
        errorPrefix = `⚠️ Task failed${exitSuffix}. Retry: /retry ${result.sessionId}`;
      } else if (result.status === 'crashed') {
        errorPrefix = `⚠️ Task crashed (${result.error ?? 'unknown'}). Retry: /retry ${result.sessionId}`;
      } else if (result.status === 'cancelled') {
        errorPrefix = '⏹ Cancelled.';
      }

      if (!totalText && errorPrefix) {
        // Nothing streamed — overwrite the opener with just the error line.
        try {
          await deps.api.editMessageText(deps.chatId, currentMessageId, errorPrefix);
        } catch (e) {
          logTelegramEditFail(deps.logger, e, currentMessageId, 'final-error edit');
        }
      } else {
        await flush({ final: !errorPrefix, ...(errorPrefix ? { errorPrefix } : {}) });
      }

      // Cache-hit ratio: how much of the input was served from the prompt
      // cache vs fresh. High cacheRead = our cache-stable prefix is working.
      const fresh = result.tokensInputFresh ?? 0;
      const cacheCreation = result.tokensCacheCreation ?? 0;
      const cacheRead = result.tokensCacheRead ?? 0;
      const cachedShare =
        result.tokensInput > 0
          ? Math.round((cacheRead / result.tokensInput) * 100)
          : 0;
      deps.logger.info(
        {
          sessionId: result.sessionId,
          status: result.status,
          tokensIn: result.tokensInput,
          tokensOut: result.tokensOutput,
          fresh,
          cacheCreation,
          cacheRead,
          cachedPct: cachedShare,
          durationMs: Date.now() - startedAt,
          totalChars: totalText.length,
        },
        'session end',
      );

      // Phase 3: process any memory proposals the agent queued via the MCP
      // tool during this session. Only run on clean/completed endings —
      // cancelled / crashed sessions leave proposals in `pending` for the
      // TTL cron to age out.
      if (result.status === 'completed' && deps.proposalProcessor) {
        try {
          const out = await processSessionProposals(result.sessionId, String(deps.chatId), {
            ...deps.proposalProcessor,
            api: deps.api,
            logger: deps.logger,
          });
          if (out.sent + out.autoAccepted > 0) {
            deps.logger.info(
              {
                sessionId: result.sessionId,
                proposalsSent: out.sent,
                proposalsAutoAccepted: out.autoAccepted,
              },
              'memory proposals dispatched',
            );
          }
        } catch (e) {
          deps.logger.warn(
            { err: (e as Error).message, sessionId: result.sessionId },
            'memory proposal post-processing failed',
          );
        }
      }
    },
  };
}

function logTelegramEditFail(
  logger: Logger,
  err: unknown,
  messageId: number,
  label: string,
): void {
  logger.warn(
    { err: (err as Error).message, messageId, label },
    'telegram edit failed',
  );
}

/**
 * Edit a message as "done" — apply `parse_mode` (if configured) so any HTML
 * in the body renders. On a parse-entities 400 (malformed tags from the
 * agent), retry once as plain text so content isn't lost. Never throws —
 * logs via {@link logTelegramEditFail}.
 */
async function editFinalized(
  deps: StreamSinkDeps,
  messageId: number,
  body: string,
  label: string,
): Promise<void> {
  try {
    await deps.api.editMessageText(
      deps.chatId,
      messageId,
      body,
      deps.parseMode ? { parse_mode: deps.parseMode } : {},
    );
    return;
  } catch (e) {
    const msg = (e as Error).message;
    if (/message is not modified/i.test(msg)) return;
    if (deps.parseMode && isParseEntitiesError(msg)) {
      deps.logger.warn(
        { err: msg, parseMode: deps.parseMode, label },
        'telegram parse_mode rejected; resending plain',
      );
      try {
        await deps.api.editMessageText(deps.chatId, messageId, body);
        return;
      } catch (e2) {
        logTelegramEditFail(deps.logger, e2, messageId, `${label} (plain fallback)`);
        return;
      }
    }
    logTelegramEditFail(deps.logger, e, messageId, label);
  }
}

/**
 * Telegram's 400 response body for malformed HTML/MarkdownV2 is roughly
 * `Bad Request: can't parse entities: <reason>`. grammy wraps that in
 * `GrammyError` but preserves the text. Match loosely.
 */
function isParseEntitiesError(msg: string): boolean {
  return /can.?t parse entities/i.test(msg);
}

/**
 * Rolling-window rate limiter: counts events within the last `windowMs`.
 * Also exported for unit tests.
 */
export class RollingRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private events: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  canAcquire(now: number = Date.now()): boolean {
    this.prune(now);
    return this.events.length < this.limit;
  }

  record(now: number = Date.now()): void {
    this.events.push(now);
    this.prune(now);
  }

  count(now: number = Date.now()): number {
    this.prune(now);
    return this.events.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i]! < cutoff) i++;
    if (i > 0) this.events.splice(0, i);
  }
}
