import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageRecord } from '../db/repositories/messages.js';

export interface MemoryEntrySnapshot {
  scope: string;
  key: string | null;
  value: string;
}

export interface SkillPromptSnapshot {
  name: string;
  skillMdContent: string;
}

export interface ContextAssemblyInput {
  agentName: string;
  model: string;
  timezone: string;
  principalLabel: string;
  activeMemory: MemoryEntrySnapshot[];
  activeSkills: SkillPromptSnapshot[];
  conversationHistory: MessageRecord[];
  /** Max characters of history transcript to include (very cheap cap). */
  historyBudgetChars?: number;
  /** Override for the base prompt path (tests only). */
  basePromptPathOverride?: string;
  /**
   * If true, include a "## Memory tool" block instructing the agent how to
   * propose memory entries via the `mcp__andybioticlaw-memory__memory_propose`
   * tool. Phase 3+: always true when running through the real session stack.
   */
  memoryToolDescribed?: boolean;
}

export interface AssembledContext {
  systemPrompt: string;
  trimmedHistoryMessages: number;
}

const DEFAULT_HISTORY_BUDGET = 40_000;

/**
 * Assemble the full system prompt for a new session.
 *
 * Layer order (per spec):
 *   1. Base prompt from src/agent/prompts/system.base.md with {{agent.name}} substituted.
 *   2. Active memory entries (bullet list).
 *   3. SKILL.md contents for each active skill.
 *   4. Meta info (current time, model, principal, timezone).
 *   5. Conversation history transcript (trimmed oldest-first if too long).
 *
 * We embed conversation history in the system prompt rather than streaming
 * it as real user/assistant turns via `--input-format stream-json`. See
 * README § Design Decisions for the rationale.
 */
export function assembleContext(input: ContextAssemblyInput): AssembledContext {
  const base = loadBasePrompt(input.basePromptPathOverride).replaceAll(
    '{{agent.name}}',
    input.agentName,
  );

  const sections: string[] = [base.trimEnd()];

  if (input.activeMemory.length > 0) {
    const bullets = input.activeMemory
      .map((m) => {
        const label = m.key ? `${m.scope} · ${m.key}` : m.scope;
        return `- [${label}] ${m.value}`;
      })
      .join('\n');
    sections.push(`## Active memory\n\n${bullets}`);
  } else {
    sections.push(`## Active memory\n\n(no entries)`);
  }

  if (input.activeSkills.length > 0) {
    const skillBlocks = input.activeSkills
      .map((s) => `### ${s.name}\n\n${s.skillMdContent.trim()}`)
      .join('\n\n');
    sections.push(`## Installed skills\n\n${skillBlocks}`);
  }

  if (input.memoryToolDescribed) {
    sections.push(memoryToolSection());
  }

  sections.push(assembleMeta(input));

  const { transcript, trimmed } = renderHistory(
    input.conversationHistory,
    input.historyBudgetChars ?? DEFAULT_HISTORY_BUDGET,
  );

  if (transcript) {
    sections.push(
      [
        '## Conversation history',
        '',
        'These are the messages exchanged in this chat so far. Use them for context, but do not repeat them. The new user message follows as your prompt.',
        '',
        transcript,
      ].join('\n'),
    );
  }

  return {
    systemPrompt: sections.join('\n\n'),
    trimmedHistoryMessages: trimmed,
  };
}

function memoryToolSection(): string {
  return [
    '## Memory tool',
    '',
    'You have a tool `mcp__andybioticlaw-memory__memory_propose` that queues a memory entry for the user to accept or dismiss via an inline button in Telegram.',
    '',
    'Call it when you learn something worth remembering for future sessions — preferences, recurring facts, long-lived context. Keep proposals terse and load-bearing; never chronological summaries.',
    '',
    'Arguments:',
    '- `scope`: one of `global` (all chats), `user:<id>` (a specific user), or `chat:<id>` (a specific chat). If unsure, use `global`.',
    '- `value`: the memory text the user will see. One or two sentences max.',
    '- `key` (optional): short identifier, e.g. `pref/language`.',
    '- `ttl_seconds` (optional): auto-expire after N seconds from acceptance.',
    '',
    'The user sees an inline button after your response. Do not mention the proposal in your reply text — the button speaks for itself.',
  ].join('\n');
}

function assembleMeta(input: ContextAssemblyInput): string {
  const now = new Date().toLocaleString('en-GB', {
    timeZone: input.timezone,
    hour12: false,
  });
  return [
    '## Runtime context',
    '',
    `- Agent name: ${input.agentName}`,
    `- Model: ${input.model}`,
    `- Timezone: ${input.timezone}`,
    `- Principal: ${input.principalLabel}`,
    `- Current time: ${now} (${input.timezone})`,
  ].join('\n');
}

function renderHistory(
  messages: MessageRecord[],
  budgetChars: number,
): { transcript: string; trimmed: number } {
  // Oldest → newest. If we blow the budget, drop the oldest until we fit.
  const working = messages.slice();
  let trimmed = 0;

  const renderOne = (m: MessageRecord): string => {
    const role =
      m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    return `${role}: ${m.content}`;
  };

  let transcript = working.map(renderOne).join('\n\n');
  while (transcript.length > budgetChars && working.length > 0) {
    working.shift();
    trimmed += 1;
    transcript = working.map(renderOne).join('\n\n');
  }
  return { transcript, trimmed };
}

function loadBasePrompt(override?: string): string {
  const path =
    override ??
    resolve(dirname(fileURLToPath(import.meta.url)), 'prompts', 'system.base.md');
  return readFileSync(path, 'utf8');
}
