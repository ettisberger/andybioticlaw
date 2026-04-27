import { z } from 'zod';
import { ScheduleKind } from '../scheduler/payloads.js';

/**
 * Per-context policy as stored in `policies.json`. Every field is
 * optional so a context using `_inherits` can leave fields blank and
 * pick them up from the parent. The resolver layers values from the
 * parent + defaults to produce a `ResolvedPolicy`.
 *
 * Mirrors OpenClaw's `exec-approvals.json` shape but extended to cover
 * scheduling kinds + skill visibility, since our service needs to gate
 * those alongside shell exec.
 */
export const PolicyContext = z.object({
  /** Optional human label for the dashboard. Not load-bearing. */
  _label: z.string().optional(),
  /**
   * Optional inheritance — when set, this context's effective policy is
   * the named context's policy with this entry's fields layered on top.
   * One level only — no chains, no cycles. The resolver throws on a
   * missing parent or a nested chain.
   */
  _inherits: z.string().optional(),

  // ----- scheduling -----
  /** Which `--kind`s are allowed when this context creates a schedule. */
  scheduleKinds: z.array(ScheduleKind).optional(),
  /** Cap on active `agent-task` schedules created from this context. */
  scheduleAgentTaskCap: z.number().int().min(0).optional(),

  // ----- shell execution -----
  /**
   * Allow-mode for the agent's Bash tool.
   *   - 'deny'      = no Bash patterns allowed
   *   - 'allowlist' = only patterns matching `execAllow` allowed
   *   - 'full'      = mirrors today's `bypassPermissions` behaviour
   *
   * Step 4 of the refactor wires this into the per-session `.claude/settings.json`.
   * Until then it's stored but unused.
   */
  execMode: z.enum(['deny', 'allowlist', 'full']).optional(),
  /** Bash patterns Claude Code permits, e.g. `Bash(git status*)`.
   *  Same shape as Claude Code's native `permissions.allow`. */
  execAllow: z.array(z.string()).optional(),

  // ----- skills -----
  /**
   * Which skills are visible. `['*']` = every enabled skill. An explicit
   * list = only the named skills.
   */
  skillsVisible: z.array(z.string()).optional(),

  // ----- delivery -----
  /**
   * Optional override for where scheduled-result messages get delivered.
   * When unset, the dispatcher delivers to the context's chatId.
   */
  deliverToChatId: z.number().int().optional(),
});
export type PolicyContext = z.infer<typeof PolicyContext>;

/**
 * Top-level policies file. Versioned for forward-compat.
 */
export const PoliciesFile = z.object({
  version: z.literal(1),
  /** Catch-all policy applied when no context-keyed entry matches. */
  defaults: PolicyContext.optional(),
  /** Per-context policies. Keys are `<agentId>:<channel>:<chatId>`. */
  contexts: z.record(z.string(), PolicyContext).default({}),
});
export type PoliciesFile = z.infer<typeof PoliciesFile>;

/**
 * Effective policy after resolution — every field has a definite value.
 * Inheritance + file `defaults` + hard-coded fallbacks have all been
 * applied. Callers downstream (the schedule gate, the per-session
 * settings.json generator, the skill loader) consume this shape.
 */
export interface ResolvedPolicy {
  /** Hard-coded fallback when no file-level defaults are set. */
  scheduleKinds: ReadonlyArray<z.infer<typeof ScheduleKind>>;
  scheduleAgentTaskCap: number;
  execMode: 'deny' | 'allowlist' | 'full';
  execAllow: ReadonlyArray<string>;
  skillsVisible: ReadonlyArray<string>;
  deliverToChatId?: number;
  _label?: string;
}

/** The hard-coded floor when neither the context nor `defaults` sets a
 *  field. Conservative — anything missing is denied. */
export const HARDCODED_FALLBACK: ResolvedPolicy = {
  scheduleKinds: ['reminder'],
  scheduleAgentTaskCap: 0,
  execMode: 'deny',
  execAllow: [],
  skillsVisible: [],
};
