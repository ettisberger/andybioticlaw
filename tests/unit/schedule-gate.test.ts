import { describe, it, expect } from 'vitest';
import {
  AGENT_TASK_SCHEDULE_CAP,
  evaluateScheduleKindGate,
} from '../../src/cli/commands/schedule-gate.js';

/**
 * The gate is the only thing standing between Emma and arbitrary shell
 * execution at cron times. The matrix below is the contract.
 */

describe('evaluateScheduleKindGate', () => {
  it('allows reminder without the bash flag', () => {
    const r = evaluateScheduleKindGate({
      kind: 'reminder',
      agentCanBash: false,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('allows agent-task without the bash flag, under the cap', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      agentCanBash: false,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses agent-task when at the cap', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      agentCanBash: false,
      agentTaskCount: AGENT_TASK_SCHEDULE_CAP,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cap reached/);
  });

  it('refuses agent-task when over the cap (defensive)', () => {
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      agentCanBash: false,
      agentTaskCount: AGENT_TASK_SCHEDULE_CAP + 5,
    });
    expect(r.ok).toBe(false);
  });

  it('still allows agent-task at the cap when the bash flag is set', () => {
    // Principal acting directly — caps don't apply.
    const r = evaluateScheduleKindGate({
      kind: 'agent-task',
      agentCanBash: true,
      agentTaskCount: AGENT_TASK_SCHEDULE_CAP + 100,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses bash without the bash flag', () => {
    const r = evaluateScheduleKindGate({
      kind: 'bash',
      agentCanBash: false,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/principal-only/);
  });

  it('allows bash with the bash flag', () => {
    const r = evaluateScheduleKindGate({
      kind: 'bash',
      agentCanBash: true,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses http-check without the bash flag', () => {
    const r = evaluateScheduleKindGate({
      kind: 'http-check',
      agentCanBash: false,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('allows http-check with the bash flag', () => {
    const r = evaluateScheduleKindGate({
      kind: 'http-check',
      agentCanBash: true,
      agentTaskCount: 0,
    });
    expect(r.ok).toBe(true);
  });
});
