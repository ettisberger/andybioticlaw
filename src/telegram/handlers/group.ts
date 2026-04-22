import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';
import type { AuditRepo } from '../../db/repositories/audit.js';

/**
 * Group-chat handler skeleton. v1: every group message is rejected with an
 * audit-log entry. The code path exists so the rest of the stack can be
 * written with groups in mind — but nothing downstream is allowed to depend on
 * group messages actually reaching a handler.
 */
export function registerGroupRejectHandler(
  bot: Bot,
  audit: AuditRepo,
  logger: Logger,
): void {
  const reject = async (ctx: Context) => {
    if (!ctx.chat) return;
    const type = ctx.chat.type;
    if (type !== 'group' && type !== 'supergroup' && type !== 'channel') return;
    audit.record({
      kind: 'unauthorized_access',
      actor: `tg:${type}:${ctx.chat.id}`,
      detail: {
        scope: 'group',
        chatType: type,
        chatId: ctx.chat.id,
        reason: 'groups rejected in v1',
      },
    });
    logger.info(
      { chatId: ctx.chat.id, type },
      'rejected group/channel message — v1 is DM-only',
    );
    try {
      await ctx.reply(
        '🚫 Group chats are not supported in this version. DM me instead.',
      );
    } catch (e) {
      logger.debug({ err: (e as Error).message }, 'group rejection reply failed');
    }
  };
  bot.on('message', reject);
}
