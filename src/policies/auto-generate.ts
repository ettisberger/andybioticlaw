import type { PoliciesFile } from './schema.js';

export interface SynthesizeInput {
  /** Default agent's stable id (from `agents.find(a => a.default)`). */
  defaultAgentId: string;
  /** Operator's principal Telegram user id (DM). */
  principalUserId: number | null;
}

/**
 * Build a default `policies.json` for a fresh install. Conservative
 * defaults for unknown contexts (deny shell, reminder-only schedules);
 * permissive principal context (mirror today's bypassPermissions
 * behaviour) so existing operators don't get locked out by the migration.
 *
 * The "permissive on day one, tighten later" stance was an explicit
 * call from the operator — see commit history for the discussion.
 * The dashboard /policies page (step 9) lets them tighten when ready.
 */
export function synthesizeDefaultPolicies(input: SynthesizeInput): PoliciesFile {
  const file: PoliciesFile = {
    version: 1,
    defaults: {
      // Conservative for any context that isn't the principal — schedules
      // limited to reminders, no shell access, no skill access.
      _label: 'fallback policy for un-named contexts',
      scheduleKinds: ['reminder'],
      scheduleAgentTaskCap: 0,
      execMode: 'deny',
      execAllow: [],
      skillsVisible: [],
    },
    contexts: {},
  };

  if (input.principalUserId !== null) {
    const key = `${input.defaultAgentId}:telegram:${input.principalUserId}`;
    file.contexts[key] = {
      _label: 'principal DM (auto-generated)',
      // Mirrors the schedule-gate I shipped earlier: principal can do
      // reminders + agent-tasks, capped at 20 active agent-tasks.
      scheduleKinds: ['reminder', 'agent-task'],
      scheduleAgentTaskCap: 20,
      // Permissive on day one — matches today's `--permission-mode bypassPermissions`
      // behaviour. Operator can flip to 'allowlist' + populate execAllow when ready.
      execMode: 'full',
      execAllow: [],
      // Wildcard: all enabled skills are visible.
      skillsVisible: ['*'],
    };

    // A separate context for schedule-fired agent runs Emma created
    // herself. Same skills + scheduleKinds as the DM, but inherits the
    // execMode so tightening the DM later automatically tightens the
    // self-scheduled context too. (Inherits is the cleaner shape; using
    // it here proves the resolver works end-to-end.)
    file.contexts[`${input.defaultAgentId}:schedule:agent-task`] = {
      _label: 'agent-task schedules Emma created (auto-generated)',
      _inherits: key,
    };
  }

  return file;
}
