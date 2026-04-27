import type { ScheduleKind } from '../../scheduler/payloads.js';
import type { ResolvedPolicy } from '../../policies/schema.js';

/**
 * Cap on how many `agent-task` schedules can exist at once. Defaults
 * here are the floor; the per-context `policy.scheduleAgentTaskCap`
 * overrides. Catches a prompt-injection loop where Emma is talked
 * into creating thousands.
 */
export const AGENT_TASK_SCHEDULE_CAP = 20;

export interface GateInput {
  kind: ScheduleKind;
  /**
   * Resolved policy for the caller's context. When `null`, the caller
   * is acting OUTSIDE a session (e.g. the operator's interactive shell
   * — no `ANDYBIOTICLAW_CONTEXT_KEY` env-var set) and the gate allows
   * everything: it's the principal acting directly.
   */
  policy: ResolvedPolicy | null;
  /** Current count of `agent-task` rows in the schedules table. */
  agentTaskCount: number;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Decide whether a `schedule add --<kind>` invocation is allowed.
 *
 *   - Outside a session (operator's shell, `policy = null`): allow
 *     everything. The principal is acting directly.
 *   - Inside a session (Emma shells out to the CLI): the caller's
 *     context policy gates the kind via `policy.scheduleKinds`. The
 *     auto-generated principal-DM context allows `reminder` +
 *     `agent-task`; the catch-all defaults restrict to `reminder`.
 *   - `agent-task` is additionally capped at
 *     `policy.scheduleAgentTaskCap` (or {@link AGENT_TASK_SCHEDULE_CAP}
 *     when the policy doesn't set one) to bound runaway creation.
 *
 * Pure function — no I/O — so the matrix is unit-testable.
 */
export function evaluateScheduleKindGate(input: GateInput): GateResult {
  // Operator acting directly (no session env var). Skip every gate.
  if (input.policy === null) return { ok: true };

  if (!input.policy.scheduleKinds.includes(input.kind)) {
    return {
      ok: false,
      reason: `kind "${input.kind}" not in policy.scheduleKinds (${input.policy.scheduleKinds.join(', ')})`,
    };
  }

  if (input.kind === 'agent-task') {
    const cap = input.policy.scheduleAgentTaskCap;
    if (input.agentTaskCount >= cap) {
      return {
        ok: false,
        reason: `agent-task schedule cap reached (${input.agentTaskCount}/${cap}) — archive or delete an existing one first`,
      };
    }
  }

  return { ok: true };
}
