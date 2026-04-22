import type { Api } from 'grammy';
import type { Logger } from 'pino';
import type { StreamSink, SessionExecuteResult } from '../agent/session.js';

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
 * If the session fails/crashes the sink still sends a short notification so
 * the operator knows the schedule misbehaved.
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
      try {
        await opts.api.sendMessage(opts.chatId, full);
      } catch (e) {
        opts.logger.warn(
          { err: (e as Error).message },
          'scheduler output send failed',
        );
      }
      return;
    }
    // Split on chunk boundaries.
    let first = true;
    let remaining = body;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, MAX_MESSAGE_CHARS - (first ? header.length + 2 : 0));
      remaining = remaining.slice(chunk.length);
      const text = first ? `${header}\n\n${chunk}` : chunk;
      try {
        await opts.api.sendMessage(opts.chatId, text);
      } catch (e) {
        opts.logger.warn(
          { err: (e as Error).message },
          'scheduler output send failed (chunk)',
        );
      }
      first = false;
    }
  }

  return {
    onDelta(text) {
      buffer += text;
    },
    async onEnd(result: SessionExecuteResult) {
      if (result.status === 'completed') {
        if (buffer.trim().length === 0) {
          opts.logger.info(
            { scheduleName: opts.scheduleName, sessionId: result.sessionId },
            'scheduled session produced no output — skipping send',
          );
          return;
        }
        await sendChunked(`📅 *${opts.scheduleName}*`, buffer);
        return;
      }
      if (result.status === 'cancelled') {
        await sendChunked(
          `📅 *${opts.scheduleName}*  (cancelled)`,
          buffer || '_cancelled before any output_',
        );
        return;
      }
      // failed / crashed
      const errLine = result.error ? `\n\n_error: ${result.error}_` : '';
      await sendChunked(
        `⚠️ *${opts.scheduleName}*  (${result.status})${errLine}`,
        buffer || '_no output_',
      );
    },
  };
}
