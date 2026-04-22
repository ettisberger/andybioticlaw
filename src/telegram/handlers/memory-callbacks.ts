import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { MemoryRepo } from '../../db/repositories/memory.js';
import type { AuditRepo } from '../../db/repositories/audit.js';
import type { MemoryManager } from '../../memory/manager.js';

export interface MemoryCallbacksDeps {
  bot: Bot;
  memoryRepo: MemoryRepo;
  audit: AuditRepo;
  manager: MemoryManager;
  logger: Logger;
}

/**
 * Inline-button callbacks for agent memory proposals. Two callback-data forms:
 *   - `mem-accept:<proposal-id>`
 *   - `mem-dismiss:<proposal-id>`
 *
 * On accept: persist to memory, mark proposal accepted, edit the prompt
 * message to confirm.
 * On dismiss: mark proposal dismissed, edit the prompt message to confirm.
 */
export function registerMemoryCallbacks(deps: MemoryCallbacksDeps): void {
  deps.bot.callbackQuery(/^mem-(accept|dismiss):(\d+)$/, async (ctx) => {
    const match = ctx.match;
    if (!match) return;
    const action = match[1] as 'accept' | 'dismiss';
    const proposalId = Number(match[2]);
    if (!Number.isInteger(proposalId)) {
      await ctx.answerCallbackQuery({ text: 'invalid proposal id' });
      return;
    }

    const proposal = deps.memoryRepo.proposalGet(proposalId);
    if (!proposal) {
      await ctx.answerCallbackQuery({ text: 'proposal not found' });
      return;
    }
    if (proposal.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: `already ${proposal.status}` });
      return;
    }

    if (action === 'accept') {
      try {
        const entry = deps.manager.addManual({
          scope: proposal.scope,
          value: proposal.proposed_value,
          ...(proposal.proposed_key ? { key: proposal.proposed_key } : {}),
          ...(proposal.ttl_seconds ? { ttlSeconds: proposal.ttl_seconds } : {}),
        });
        deps.memoryRepo.proposalAccept(proposalId, entry.id);
        deps.audit.record({
          kind: 'memory_proposal_accepted',
          actor: String(ctx.from?.id ?? '?'),
          detail: { proposalId, memoryId: entry.id, scope: proposal.scope },
        });
        await ctx.editMessageText(
          `🧠 Added to memory (scope: \`${proposal.scope}\`).`,
          { parse_mode: 'Markdown' },
        );
        await ctx.answerCallbackQuery({ text: 'added' });
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message, proposalId },
          'memory accept callback failed',
        );
        await ctx.answerCallbackQuery({ text: `error: ${(e as Error).message}` });
      }
      return;
    }

    // dismiss
    deps.memoryRepo.proposalDismiss(proposalId);
    deps.audit.record({
      kind: 'memory_proposal_dismissed',
      actor: String(ctx.from?.id ?? '?'),
      detail: { proposalId, scope: proposal.scope },
    });
    try {
      await ctx.editMessageText('🙅 Dismissed — nothing stored.');
    } catch {
      /* benign — message may have been edited already */
    }
    await ctx.answerCallbackQuery({ text: 'dismissed' });
  });
}
