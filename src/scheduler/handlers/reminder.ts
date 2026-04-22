import type { Handler, HandlerContext, HandlerResult } from './types.js';
import type { ReminderPayload } from '../payloads.js';

/**
 * `reminder` kind: sends a plain Telegram message to the configured chat.
 * No agent, no tokens, no model roundtrip.
 */
export const reminderHandler: Handler<ReminderPayload> = {
  kind: 'reminder',
  async run(payload: ReminderPayload, ctx: HandlerContext): Promise<HandlerResult> {
    const chatIdStr = payload.chatId ?? (ctx.defaultChatId !== null ? String(ctx.defaultChatId) : null);
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
    try {
      await ctx.telegramApi.sendMessage(chatId, payload.text);
      return { status: 'success', output: `sent to ${chatIdStr}` };
    } catch (e) {
      return {
        status: 'fail',
        error: `telegram sendMessage failed: ${(e as Error).message}`,
      };
    }
  },
};
