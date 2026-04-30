import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { StreamSink, SessionExecuteResult } from '../agent/session.js';
import { htmlEscape, sendTelegramHtml } from '../telegram/streaming.js';

const MAX_MESSAGE_CHARS = 3900;

/**
 * StreamSink for scheduler-triggered agent sessions. Unlike the interactive
 * DM sink, this one:
 *   - Does NOT edit an opening "…" message (the user didn't ask anything —
 *     the scheduler did). There's no message to stream into.
 *   - Collects all deltas and sends one or more complete messages at the
 *     end, prefixed with the schedule name so the principal knows what the
 *     message is from.
 *
 * Telegram parse_mode: HTML matches the interactive DM sink, so any
 * `<b>` / `<i>` / `<a href="…">` Emma emits renders correctly. The
 * shared `sendTelegramHtml` helper handles the parse-entities fallback
 * (resend as plain text on malformed HTML).
 *
 * If the session fails/crashes the sink still sends a short notification
 * so the operator knows the schedule misbehaved.
 */
export function createSchedulerTelegramSink(opts: {
  api: Api;
  chatId: number;
  scheduleName: string;
  logger: Logger;
}): StreamSink {
  let buffer = '';

  async function sendChunked(header: string, body: string): Promise<void> {
    const full = `${header}\n\n${body}`;
    if (full.length <= MAX_MESSAGE_CHARS) {
      await sendTelegramHtml(opts.api, opts.chatId, full, {
        logger: opts.logger,
        label: `scheduler:${opts.scheduleName}`,
      });
      return;
    }
    // Split on chunk boundaries.
    let first = true;
    let remaining = body;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, MAX_MESSAGE_CHARS - (first ? header.length + 2 : 0));
      remaining = remaining.slice(chunk.length);
      const text = first ? `${header}\n\n${chunk}` : chunk;
      await sendTelegramHtml(opts.api, opts.chatId, text, {
        logger: opts.logger,
        label: `scheduler:${opts.scheduleName}:${first ? 'chunk-first' : 'chunk'}`,
      });
      first = false;
    }
  }

  return {
    onDelta(text) {
      buffer += text;
    },
    async onEnd(result: SessionExecuteResult) {
      const safeName = htmlEscape(opts.scheduleName);
      if (result.status === 'completed') {
        if (buffer.trim().length === 0) {
          opts.logger.info(
            { scheduleName: opts.scheduleName, sessionId: result.sessionId },
            'scheduled session produced no output — skipping send',
          );
          return;
        }
        await sendChunked(`📅 <b>${safeName}</b>`, buffer);
        return;
      }
      if (result.status === 'cancelled') {
        await sendChunked(
          `📅 <b>${safeName}</b>  (cancelled)`,
          buffer || '<i>cancelled before any output</i>',
        );
        return;
      }
      // failed / crashed
      const errLine = result.error
        ? `\n\n<i>error: ${htmlEscape(result.error)}</i>`
        : '';
      await sendChunked(
        `⚠️ <b>${safeName}</b>  (${result.status})${errLine}`,
        buffer || '<i>no output</i>',
      );
    },
  };
}
