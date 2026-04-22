import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { MemoryManager } from '../../memory/manager.js';
import type { AuditRepo } from '../../db/repositories/audit.js';

export interface MemoryCommandsDeps {
  bot: Bot;
  manager: MemoryManager;
  audit: AuditRepo;
  logger: Logger;
  /** Telegram user id of the principal — used to default `/remember` to `user:<id>`. */
  principalUserId: number | null;
}

export function registerMemoryCommands(deps: MemoryCommandsDeps): void {
  deps.bot.command('remember', async (ctx) => {
    const text = ctx.match?.toString().trim() ?? '';
    if (!text) {
      await ctx.reply(
        [
          'Usage:',
          '  /remember <text>               — stores under `user:<your-id>`',
          '  /remember @global <text>       — stores under `global`',
          '  /remember @chat <text>         — stores under `chat:<this-chat>`',
          '  /remember @<scope> <text>      — stores under a custom scope',
        ].join('\n'),
      );
      return;
    }

    let scope: string;
    let value: string;
    const scopeMatch = text.match(/^@([\w:-]+)\s+(.+)$/s);
    if (scopeMatch) {
      const token = scopeMatch[1]!;
      value = scopeMatch[2]!;
      if (token === 'global') scope = 'global';
      else if (token === 'chat') scope = `chat:${ctx.chat?.id ?? '?'}`;
      else if (token === 'user') scope = `user:${ctx.from?.id ?? '?'}`;
      else scope = token;
    } else {
      scope = deps.principalUserId !== null ? `user:${deps.principalUserId}` : 'global';
      value = text;
    }

    try {
      const entry = deps.manager.addManual({ scope, value });
      deps.audit.record({
        kind: 'memory_added_manual',
        actor: String(ctx.from?.id ?? '?'),
        detail: { id: entry.id, scope, source: 'telegram' },
      });
      await ctx.reply(
        `🧠 Stored in \`${scope}\` (id ${entry.id}).`,
        { parse_mode: 'Markdown' },
      );
    } catch (e) {
      await ctx.reply(`⚠️ ${(e as Error).message}`);
    }
  });

  deps.bot.command('memory', async (ctx) => {
    if (!ctx.chat) return;
    const principalId = deps.principalUserId;
    const scopes = deps.manager.resolveActiveScopes({
      principalUserId: principalId,
      chatId: String(ctx.chat.id),
      activeSkills: [],
    });
    const snapshot = deps.manager.snapshot(
      {
        principalUserId: principalId,
        chatId: String(ctx.chat.id),
        activeSkills: [],
      },
      25,
    );
    if (snapshot.entries.length === 0) {
      await ctx.reply(
        `No memory entries active in scopes: ${scopes.map((s) => `\`${s}\``).join(', ')}.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    const lines = [`*Active memory* (${snapshot.entries.length}):`];
    for (const e of snapshot.entries) {
      const suffix = e.ttl_at ? `  (ttl ${formatUntil(e.ttl_at)})` : '';
      const keyPart = e.key ? ` \`${e.key}\`:` : '';
      lines.push(`_id ${e.id}_ • \`${e.scope}\`${keyPart} ${truncate(e.value, 120)}${suffix}`);
    }
    if (snapshot.truncated > 0) {
      lines.push(`_(${snapshot.truncated} more — use the CLI to see all)_`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  deps.bot.command('forget', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    const id = Number(arg);
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply('Usage: /forget <id>  (find ids via /memory)');
      return;
    }
    const ok = deps.manager.remove(id);
    if (!ok) {
      await ctx.reply(`No memory entry with id ${id}.`);
      return;
    }
    deps.audit.record({
      kind: 'memory_removed_manual',
      actor: String(ctx.from?.id ?? '?'),
      detail: { id, source: 'telegram' },
    });
    await ctx.reply(`🧹 Removed memory ${id}.`);
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatUntil(ttlAt: number): string {
  const ms = ttlAt - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}
