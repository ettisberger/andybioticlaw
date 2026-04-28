import type { Bot, Context } from 'grammy';
import type { Logger } from 'pino';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import type { AuditRepo } from '../../db/repositories/audit.js';
import type { BudgetTracker } from '../../agent/budget.js';
import type { AgentConfigEntry } from '../../config/schema.js';
import type { TelegramDmSubmit } from './dm.js';
import type { TelegramCancel } from './dm.js';

export interface CommandsDeps {
  sessions: SessionsRepo;
  budget: BudgetTracker;
  audit: AuditRepo;
  /**
   * Resolve the agent for a given chat. Used by /start + /status + /help
   * so each chat sees the agent that actually answers it (per bindings).
   */
  resolveAgent: (chatId: number, userId: number) => AgentConfigEntry;
  logger: Logger;
  submit: TelegramDmSubmit;
  cancel: TelegramCancel;
  /** Timezone for rendering the reset window label in /reset_budget's reply. */
  timezone: string;
}

/**
 * User-facing slash commands we register with Telegram via
 * `setMyCommands`. The array is exported so bot.ts can feed it to the
 * Telegram API at startup without duplicating the list. NOTE:
 * Telegram's command-name validator only accepts `[a-z0-9_]` — no
 * hyphens — which is why we use underscores even though kebab-case is
 * friendlier elsewhere.
 */
export const TELEGRAM_MENU_COMMANDS: Array<{
  command: string;
  description: string;
}> = [
  { command: 'help', description: 'List commands and usage' },
  { command: 'status', description: 'Service + daily-budget summary' },
  { command: 'cancel', description: 'Abort running + queued sessions' },
  { command: 'retry', description: 'Re-run a prior session (needs id)' },
  { command: 'reset_budget', description: 'Zero the daily-budget counter' },
  { command: 'remember', description: 'Propose a memory entry' },
  { command: 'memory', description: 'Show current memory entries' },
  { command: 'forget', description: 'Delete a memory entry (needs id)' },
];

export function registerCommands(bot: Bot, deps: CommandsDeps): void {
  bot.command('start', async (ctx) => {
    if (!ctx.chat) return;
    const agent = deps.resolveAgent(ctx.chat.id, ctx.from?.id ?? ctx.chat.id);
    await ctx.reply(
      `👋 Hi, I'm ${agent.name} (model: ${agent.model}).\n\nSend me a message and I'll answer, streamed back as edits.\n\nCommands: /help, /status, /cancel, /retry <session-id>`,
    );
  });

  bot.command('help', async (ctx) => {
    if (!ctx.chat) return;
    const agent = deps.resolveAgent(ctx.chat.id, ctx.from?.id ?? ctx.chat.id);
    await ctx.reply(
      [
        `*${agent.name}* commands`,
        '',
        '/start — show this intro',
        '/help — this message',
        '/status — service + daily budget summary',
        '/cancel — abort the running session and drop any queued messages in this chat',
        '/retry <session-id> — start a new session with the original user input of a prior failed/cancelled one',
        '/reset\\_budget — zero the daily-budget counter (works even when the budget is exhausted)',
        '/remember, /memory, /forget — manage memory entries',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('status', async (ctx) => {
    if (!ctx.chat) return;
    const agent = deps.resolveAgent(ctx.chat.id, ctx.from?.id ?? ctx.chat.id);
    const s = deps.budget.status();
    const reset = new Date(s.window.nextResetMs).toLocaleString('en-GB', {
      timeZone: 'UTC',
      hour12: false,
    });
    await ctx.reply(
      [
        `*${agent.name}* — status`,
        `Model: ${agent.model}`,
        ``,
        `Daily tokens: ${s.used.toLocaleString()} / ${s.dailyLimit.toLocaleString()} (${Math.round((s.used / Math.max(1, s.dailyLimit)) * 100)}%)`,
        `Remaining:    ${s.remaining.toLocaleString()}`,
        `Window resets: ${reset} UTC`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  });

  // Accept both /reset_budget (telegram-native, appears in the `/` menu)
  // and /reset-budget (typed by hand, matches CLI convention). Grammy
  // dispatches the first matching handler, so we register both.
  const resetBudget = async (ctx: Context) => {
    if (!ctx.chat) return;
    try {
      const { before, after } = deps.budget.resetNow();
      deps.audit.record({
        kind: 'budget_reset',
        actor: `tg:${ctx.chat.id}`,
        detail: {
          previousUsed: before.used,
          previousRemaining: before.remaining,
          anchorMs: after.window.manualResetAt ?? Date.now(),
        },
      });
      deps.logger.info(
        { chatId: ctx.chat.id, previousUsed: before.used, limit: after.dailyLimit },
        'budget reset via telegram',
      );
      const natural = new Date(after.window.nextResetMs).toLocaleString('en-GB', {
        timeZone: deps.timezone,
        hour12: false,
      });
      await ctx.reply(
        [
          '✅ *Daily budget reset.*',
          '',
          `Previous: ${before.used.toLocaleString()} / ${before.dailyLimit.toLocaleString()} tokens`,
          `Now:      ${after.used.toLocaleString()} / ${after.dailyLimit.toLocaleString()}`,
          '',
          `Natural reset still fires at ${natural} (${deps.timezone}).`,
        ].join('\n'),
        { parse_mode: 'Markdown' },
      );
    } catch (e) {
      deps.logger.error({ err: (e as Error).message }, 'budget reset via telegram failed');
      await ctx.reply(`⚠️ Budget reset failed: ${(e as Error).message}`);
    }
  };
  bot.command('reset_budget', resetBudget);
  bot.command('reset-budget', resetBudget);

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
