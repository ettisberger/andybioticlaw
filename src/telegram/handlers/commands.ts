import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import type { BudgetTracker } from '../../agent/budget.js';
import type { TelegramDmSubmit } from './dm.js';
import type { TelegramCancel } from './dm.js';

export interface CommandsDeps {
  sessions: SessionsRepo;
  budget: BudgetTracker;
  agentName: string;
  model: string;
  logger: Logger;
  submit: TelegramDmSubmit;
  cancel: TelegramCancel;
}

export function registerCommands(bot: Bot, deps: CommandsDeps): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `👋 Hi, I'm ${deps.agentName} (model: ${deps.model}).\n\nSend me a message and I'll answer, streamed back as edits.\n\nCommands: /help, /status, /cancel, /retry <session-id>`,
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        `*${deps.agentName}* commands`,
        '',
        '/start — show this intro',
        '/help — this message',
        '/status — service + daily budget summary',
        '/cancel — abort the running session and drop any queued messages in this chat',
        '/retry <session-id> — start a new session with the original user input of a prior failed/cancelled one',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('status', async (ctx) => {
    const s = deps.budget.status();
    const reset = new Date(s.window.nextResetMs).toLocaleString('en-GB', {
      timeZone: 'UTC',
      hour12: false,
    });
    await ctx.reply(
      [
        `*${deps.agentName}* — status`,
        `Model: ${deps.model}`,
        ``,
        `Daily tokens: ${s.used.toLocaleString()} / ${s.dailyLimit.toLocaleString()} (${Math.round((s.used / Math.max(1, s.dailyLimit)) * 100)}%)`,
        `Remaining:    ${s.remaining.toLocaleString()}`,
        `Window resets: ${reset} UTC`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('cancel', async (ctx) => {
    if (!ctx.chat) return;
    const out = await deps.cancel(String(ctx.chat.id));
    if (!out.cancelledCurrent && out.droppedQueued === 0) {
      await ctx.reply('Nothing to cancel.');
      return;
    }
    const parts: string[] = [];
    if (out.cancelledCurrent) parts.push('cancelled running session');
    if (out.droppedQueued > 0)
      parts.push(`${out.droppedQueued} pending message${out.droppedQueued === 1 ? '' : 's'} dropped`);
    await ctx.reply(`⏹ ${parts.join('; ')}.`);
  });

  bot.command('retry', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply('Usage: /retry <session-id>');
      return;
    }
    const prior = deps.sessions.get(arg);
    if (!prior) {
      await ctx.reply(`No session with id \`${arg}\``, { parse_mode: 'Markdown' });
      return;
    }
    if (prior.source !== 'dm') {
      await ctx.reply(`Session ${arg} is not a DM session; refusing retry.`);
      return;
    }
    if (!prior.input_preview) {
      await ctx.reply(`Session ${arg} has no recoverable input; refusing retry.`);
      return;
    }
    if (!ctx.chat || String(ctx.chat.id) !== prior.source_ref) {
      await ctx.reply(
        `Session ${arg} belongs to a different chat; refusing retry.`,
      );
      return;
    }
    deps.logger.info({ retryOf: arg }, 'retrying session with prior input');
    await deps.submit(ctx, prior.input_preview, { retryOfSessionId: prior.id });
  });
}

/** Default handler for un-registered slash commands. */
export function registerUnknownCommandFallback(bot: Bot): void {
  bot.on('message', async (ctx: Context, next) => {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/') && /^\/\w+/.test(text)) {
      await ctx.reply('Unknown command. Try /help.');
      return;
    }
    await next();
  });
}
