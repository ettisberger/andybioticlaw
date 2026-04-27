import type { ScheduleKind } from '../../scheduler/payloads.js';

/**
 * Cap on how many `agent-task` schedules can exist at once. Includes the
 * principal's own — the cap exists primarily to bound a worst-case
 * prompt-injection loop where Emma is talked into creating thousands.
 * 20 is generous for a single-principal setup; promote to config if it
 * ever bites.
 */
export const AGENT_TASK_SCHEDULE_CAP = 20;

export interface GateInput {
  kind: ScheduleKind;
  /** True when the principal's shell exported `ANDYBIOTICLAW_AGENT_CAN_BASH=1`. */
  agentCanBash: boolean;
  /** Current count of `agent-task` rows in the schedules table (any
   *  enabled state). Counted by the caller via `SchedulesRepo.list()`. */
  agentTaskCount: number;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Decide whether a `schedule add --kind <kind>` invocation is allowed.
 *
 *   - With the bash flag: anything goes (the principal is acting directly).
 *   - Without it: `reminder` and `agent-task` are allowed (low-blast-radius
 *     kinds Emma can self-service). `bash` and `http-check` are refused —
 *     prompt-injection could otherwise trick Emma into running arbitrary
 *     shell or polling attacker-controlled URLs.
 *   - `agent-task` is additionally capped at {@link AGENT_TASK_SCHEDULE_CAP}
 *     to bound runaway creation.
 *
 * Pure function — no I/O — so the matrix is unit-testable.
 */
export function evaluateScheduleKindGate(input: GateInput): GateResult {
  if (input.agentCanBash) return { ok: true };

  if (input.kind === 'reminder') return { ok: true };

  if (input.kind === 'agent-task') {
    if (input.agentTaskCount >= AGENT_TASK_SCHEDULE_CAP) {
      return {
        ok: false,
        reason: `agent-task schedule cap reached (${input.agentTaskCount}/${AGENT_TASK_SCHEDULE_CAP}) — archive or delete an existing one first`,
      };
    }
    return { ok: true };
  }

  // bash, http-check
  return {
    ok: false,
    reason: `kind "${input.kind}" requires ANDYBIOTICLAW_AGENT_CAN_BASH=1 (principal-only)`,
  };
}
