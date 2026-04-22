import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';
import type { MemoryRepo, ProposalRecord } from '../db/repositories/memory.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { MemoryManager } from './manager.js';

export interface ProposalPostProcessDeps {
  api: Api;
  logger: Logger;
  memoryRepo: MemoryRepo;
  audit: AuditRepo;
  manager: MemoryManager;
  autoAccept: () => boolean;
}

/**
 * After a session ends, scan for pending memory proposals the MCP server
 * queued during the turn. Either auto-accept them (when `memory.autoAccept`)
 * or send the user an inline-button prompt to decide.
 *
 * Called from the Phase 2 sink's `onEnd` hook after the session has been
 * marked `completed`. Non-fatal — any error just logs.
 */
export async function processSessionProposals(
  sessionId: string,
  chatId: string,
  deps: ProposalPostProcessDeps,
): Promise<{ sent: number; autoAccepted: number }> {
  const pending = deps.memoryRepo.proposalListPending(sessionId);
  if (pending.length === 0) return { sent: 0, autoAccepted: 0 };

  if (deps.autoAccept()) {
    // Silent auto-accept: Emma's own reply already told the user she's
    // remembering this; a separate "🧠 Auto-remembered: …" message would
    // just be UI noise. Audit rows still capture the decision.
    let autoAccepted = 0;
    for (const p of pending) {
      try {
        const memory = deps.manager.addManual({
          scope: p.scope,
          value: p.proposed_value,
          ...(p.proposed_key ? { key: p.proposed_key } : {}),
          ...(p.ttl_seconds ? { ttlSeconds: p.ttl_seconds } : {}),
        });
        deps.memoryRepo.proposalAccept(p.id, memory.id);
        deps.audit.record({
          kind: 'memory_proposal_auto_accepted',
          actor: chatId,
          detail: { proposalId: p.id, memoryId: memory.id, scope: p.scope },
        });
        autoAccepted += 1;
      } catch (e) {
        deps.logger.warn(
          { err: (e as Error).message, proposalId: p.id, scope: p.scope },
          'auto-accept of memory proposal failed',
        );
      }
    }
    return { sent: 0, autoAccepted };
  }

  let sent = 0;
  for (const p of pending) {
    const text = renderProposalPrompt(p);
    const kb = new InlineKeyboard()
      .text('✅ Add', `mem-accept:${p.id}`)
      .text('❌ Dismiss', `mem-dismiss:${p.id}`);
    try {
      const msg = await deps.api.sendMessage(Number(chatId), text, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
      deps.memoryRepo.proposalSetButton(p.id, chatId, msg.message_id);
      sent += 1;
    } catch (e) {
      deps.logger.warn(
        { err: (e as Error).message, proposalId: p.id },
        'failed to send proposal prompt',
      );
    }
  }
  return { sent, autoAccepted: 0 };
}

function renderProposalPrompt(p: ProposalRecord): string {
  const lines: string[] = ['🧠 *Propose memory*'];
  lines.push(`Scope: \`${p.scope}\``);
  if (p.proposed_key) lines.push(`Key: \`${p.proposed_key}\``);
  if (p.ttl_seconds) lines.push(`TTL: ${p.ttl_seconds}s`);
  lines.push('');
  lines.push(`_${escapeMarkdown(truncate(p.proposed_value, 500))}_`);
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeMarkdown(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1');
}
