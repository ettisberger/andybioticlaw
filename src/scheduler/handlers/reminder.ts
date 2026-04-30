import type { Handler, HandlerContext, HandlerResult } from './types.js';
import type { ReminderPayload } from '../payloads.js';
import { htmlEscape, sendTelegramHtml } from '../../telegram/streaming.js';

/**
 * `reminder` kind: sends a fixed Telegram message to the configured chat.
 * No agent, no tokens, no model roundtrip.
 *
 * Output shape — wraps the payload text with a header derived from the
 * schedule name so the principal sees what fired:
 *
 *     ⏰ <b>{scheduleName}</b>
 *
 *     {payload.text}
 *
 * `parse_mode: 'HTML'` is set so any `<b>` / `<i>` / `<a href="…">`
 * Emma puts into `--reminder` renders. On malformed HTML, the shared
 * `sendTelegramHtml` helper falls back to plain-text resend so the
 * principal still sees the body.
 */
export const reminderHandler: Handler<ReminderPayload> = {
  kind: 'reminder',
  async run(payload: ReminderPayload, ctx: HandlerContext): Promise<HandlerResult> {
    const chatIdStr =
      payload.chatId ?? (ctx.defaultChatId !== null ? String(ctx.defaultChatId) : null);
    if (chatIdStr === null) {
      return {
        status: 'fail',
        error: 'no chatId in payload and no principal configured',
      };
    }
    const chatId = Number(chatIdStr);
    if (!Number.isFinite(chatId)) {
      return { status: 'fail', error: `invalid chatId "${chatIdStr}"` };
    }

    const safeName = htmlEscape(ctx.schedule.name);
    const text = `⏰ <b>${safeName}</b>\n\n${payload.text}`;

    try {
      await sendTelegramHtml(ctx.telegramApi, chatId, text, {
        logger: ctx.logger,
        label: `reminder:${ctx.schedule.name}`,
      });
      return { status: 'success', output: `sent to ${chatIdStr}` };
    } catch (e) {
      // sendTelegramHtml swallows transport errors internally and logs
      // them; if it does throw it's something genuinely unexpected.
      return {
        status: 'fail',
        error: `telegram send failed: ${(e as Error).message}`,
      };
    }
  },
};
