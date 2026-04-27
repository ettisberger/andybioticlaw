/**
 * Runtime "Context" — the unit of policy in the per-context refactor.
 *
 *   Context = { agentId, channel, chatId }
 *
 * Determined at session-start by `resolveBinding(...)` from incoming
 * Telegram message metadata + the operator's `bindings:` rules. Stored
 * onto sessions/schedules so per-agent and per-chat dashboards work.
 *
 * Naming convention: contexts serialize as `<agentId>:<channel>:<chatId>`
 * — same shape as memory scopes (`chat:<id>`, `user:<id>`). That string
 * is the lookup key into `data/policies.json`.
 *
 * NOTE: this file is intentionally *not* `src/agent/context.ts` — that
 * name belongs to the system-prompt assembly module. Keep the runtime
 * context separate to avoid the two concepts colliding.
 */

import type { AgentConfigEntry, BindingRule } from '../config/schema.js';

export interface RuntimeContext {
  /** Stable agent id (e.g. 'emma'). */
  agentId: string;
  /** Source channel — currently only 'telegram'. */
  channel: 'telegram';
  /** Numeric chat id — DM uses the user id; group uses the negative chat id. */
  chatId: number;
}

/** Serialize a context to its canonical string key. */
export function contextKey(ctx: RuntimeContext): string {
  return `${ctx.agentId}:${ctx.channel}:${ctx.chatId}`;
}

/** Parse a canonical context key. Returns null on malformed input. */
export function parseContextKey(key: string): RuntimeContext | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [agentId, channel, chatIdStr] = parts;
  if (!agentId || channel !== 'telegram') return null;
  const chatId = Number(chatIdStr);
  if (!Number.isFinite(chatId)) return null;
  return { agentId, channel, chatId };
}

export interface ResolveBindingInput {
  channel: 'telegram';
  chatId: number;
  /** User id from the incoming message. For groups this is the sender;
   *  for DMs it equals chatId. Used for user-id-scoped binding rules. */
  userId: number;
}

/**
 * Map an incoming message → which agent should handle it.
 *
 * Precedence (first match wins):
 *   1. A binding rule that matches BOTH chatIds (exact) AND userIds (exact).
 *   2. A binding rule that matches chatIds.
 *   3. A binding rule that matches userIds.
 *   4. A binding rule that matches the channel only (catch-all).
 *   5. The default agent (agents[].default === true).
 *
 * Throws if no rule matches AND no default agent is configured — that
 * would be a misconfiguration the operator should fix loudly.
 */
export function resolveBinding(
  input: ResolveBindingInput,
  bindings: readonly BindingRule[],
  agents: readonly AgentConfigEntry[],
): RuntimeContext {
  // Tier 1–4: search bindings in order, scoring matches by specificity.
  // Higher score = more specific = wins.
  let best: { score: number; rule: BindingRule } | null = null;
  for (const rule of bindings) {
    if (rule.match.channel !== input.channel) continue;
    let score = 0;
    if (rule.match.chatIds !== undefined) {
      if (!rule.match.chatIds.includes(input.chatId)) continue;
      score += 2;
    }
    if (rule.match.userIds !== undefined) {
      if (!rule.match.userIds.includes(input.userId)) continue;
      score += 1;
    }
    if (best === null || score > best.score) {
      best = { score, rule };
    }
  }
  if (best !== null) {
    return { agentId: best.rule.agentId, channel: input.channel, chatId: input.chatId };
  }

  // Tier 5: fall back to the default agent.
  const defaultAgent = agents.find((a) => a.default);
  if (defaultAgent) {
    return { agentId: defaultAgent.id, channel: input.channel, chatId: input.chatId };
  }

  throw new Error(
    `no binding rule matched ${input.channel}/${input.chatId} and no default agent is configured`,
  );
}

/**
 * Synthesize a single-agent `agents.list` from the legacy single-agent
 * `agent:` config block. Used by the config loader during the
 * deprecation window so configs without `agents:` keep working.
 *
 * Always produces id 'emma' to match migration 0009's DEFAULT.
 * Operators with a non-Emma legacy config should add an explicit
 * `agents:` block when they upgrade.
 */
export function synthesizeAgentsFromLegacy(legacyAgent: {
  name: string;
  model: string;
  haikuModel: string;
  credentialsDir: string;
  streamIdleTimeoutSec: number;
  routing: { enabled: boolean; minCharsForOpus: number };
}): AgentConfigEntry[] {
  return [
    {
      id: 'emma',
      name: legacyAgent.name,
      default: true,
      model: legacyAgent.model,
      haikuModel: legacyAgent.haikuModel,
      credentialsDir: legacyAgent.credentialsDir,
      streamIdleTimeoutSec: legacyAgent.streamIdleTimeoutSec,
      routing: legacyAgent.routing,
      // Wildcard: all enabled skills are visible to the synthesized agent.
      // New agents added explicitly must declare an explicit skill set.
      skills: ['*'] as Array<'*' | string>,
    },
  ];
}

/**
 * Synthesize a single catch-all binding when the operator hasn't
 * declared any. Pairs with `synthesizeAgentsFromLegacy` to give the
 * legacy single-agent install a complete (agents, bindings) pair.
 */
export function synthesizeDefaultBindings(defaultAgentId: string): BindingRule[] {
  return [{ agentId: defaultAgentId, match: { channel: 'telegram' } }];
}
