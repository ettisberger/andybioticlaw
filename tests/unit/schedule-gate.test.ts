import { describe, it, expect } from 'vitest';
import {
  AGENT_TASK_SCHEDULE_CAP,
  evaluateScheduleKindGate,
} from '../../src/cli/commands/schedule-gate.js';
import type { ResolvedPolicy } from '../../src/policies/schema.js';

/**
 * The gate is the only thing standing between Emma and arbitrary shell
 * execution at cron times. Lock the matrix here.
 */

const principalPolicy: ResolvedPolicy = {
  scheduleKinds: ['reminder', 'agent-task'],
  scheduleAgentTaskCap: 20,
  execMode: 'full',
  execAllow: [],
  skillsVisible: ['*'],
};

const reminderOnlyPolicy: ResolvedPolicy = {
  scheduleKinds: ['reminder'],
  scheduleAgentTaskCap: 0,
  execMode: 'deny',
  execAllow: [],
  skillsVisible: [],
};

describe('evaluateScheduleKindGate', () => {
  it('allows everything when policy is null (operator interactive shell)', () => {
    const r = evaluateScheduleKindGate({
      kind: 'bash',
      policy: null,
      agentTaskCount: 99,
    });
    expect(r.ok).toBe(true);
  });

  it('allows kinds in policy.scheduleKinds', () => {
    const r = evaluateScheduleKindGate({
      kind: 'reminder',
      policy: principalPolicy,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects kinds not in policy.scheduleKinds', () => {
    const r = evaluateScheduleKindGate({
      kind: 'bash',
      policy: principalPolicy,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not in policy\.scheduleKinds/);
  });

  it('reminder-only policy refuses agent-task', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      policy: reminderOnlyPolicy,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('refuses agent-task when at the policy cap', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      policy: principalPolicy,
      agentTaskCount: principalPolicy.scheduleAgentTaskCap,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cap reached/);
  });

  it('refuses agent-task when above the policy cap (defensive)', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      policy: principalPolicy,
      agentTaskCount: principalPolicy.scheduleAgentTaskCap + 5,
    });
    expect(r.ok).toBe(false);
  });

  it('still allows agent-task at the cap when policy is null (operator)', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      policy: null,
      agentTaskCount: AGENT_TASK_SCHEDULE_CAP + 100,
    });
    expect(r.ok).toBe(true);
  });

  it('exposes the legacy default cap constant for callers wanting a sensible floor', () => {
    expect(AGENT_TASK_SCHEDULE_CAP).toBe(20);
  });
});
