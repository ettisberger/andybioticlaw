import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { StreamSink, SessionExecuteResult } from '../agent/session.js';
import { isParseEntitiesError } from '../telegram/streaming.js';

const MAX_MESSAGE_CHARS = 3900;

/**
 * Escape `&` / `<` / `>` so an operator-provided schedule name like
 * `Build & Deploy <prod>` doesn't trigger the parse-entities fallback.
 * Body content trusts Emma's system-prompt rule about escaping
 * user-supplied strings; this helper is for fields WE control.
 */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
 * `<b>` / `<i>` / `<a href="…">` Emma emits renders correctly. If the
 * agent emits malformed HTML, Telegram returns a 400 "can't parse
 * entities" — we catch that and resend as plain text so the principal
 * sees the content (with literal `<b>…` markers) rather than nothing.
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

  /**
   * Send `text` with HTML parse_mode. On `can't parse entities` error
   * (malformed HTML in the agent output), retry once as plain text so
   * the principal still sees the content. Other errors are logged and
   * dropped — the schedule still ran, only the notification failed.
   */
  async function sendWithHtmlFallback(text: string, label: string): Promise<void> {
    try {
      await opts.api.sendMessage(opts.chatId, text, { parse_mode: 'HTML' });
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (isParseEntitiesError(msg)) {
        opts.logger.warn(
          { err: msg, scheduleName: opts.scheduleName, label },
          'scheduler output: telegram rejected HTML; resending plain',
        );
        try {
          await opts.api.sendMessage(opts.chatId, text);
          return;
        } catch (e2) {
          opts.logger.warn(
            { err: (e2 as Error).message, scheduleName: opts.scheduleName, label },
            'scheduler output: plain-text fallback also failed',
          );
          return;
        }
      }
      opts.logger.warn(
        { err: msg, scheduleName: opts.scheduleName, label },
        'scheduler output send failed',
      );
    }
  }

  async function sendChunked(header: string, body: string): Promise<void> {
    const full = `${header}\n\n${body}`;
    if (full.length <= MAX_MESSAGE_CHARS) {
      await sendWithHtmlFallback(full, 'single');
      return;
    }
    // Split on chunk boundaries.
    let first = true;
    let remaining = body;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, MAX_MESSAGE_CHARS - (first ? header.length + 2 : 0));
      remaining = remaining.slice(chunk.length);
      const text = first ? `${header}\n\n${chunk}` : chunk;
      await sendWithHtmlFallback(text, first ? 'chunk-first' : 'chunk');
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
