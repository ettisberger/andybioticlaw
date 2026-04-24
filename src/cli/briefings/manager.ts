/**
 * Thin CRUD over the `schedules` repo for the two canonical proactive
 * briefings: `morning-briefing` and `evening-briefing`. Both wrap the
 * existing `agent-task` scheduler kind — this module's only job is to
 * keep the two named rows in sync with operator toggles from the
 * Settings menu.
 */

import type { SchedulesRepo, ScheduleRecord } from '../../db/repositories/schedules.js';
import {
  EVENING_BRIEFING_PROMPT,
  MORNING_BRIEFING_PROMPT,
} from '../../agent/briefings/prompts.js';

export type BriefingKind = 'morning' | 'evening';

export interface BriefingStatus {
  kind: BriefingKind;
  /** True iff a matching schedule row exists AND is enabled. */
  enabled: boolean;
  /** Current time as `HH:MM`, parsed from the schedule's cron expression. */
  time: string;
}

export interface BriefingManager {
  /** Returns the current status for both briefings. */
  getStatus(): { morning: BriefingStatus; evening: BriefingStatus };
  enable(kind: BriefingKind, time: string): void;
  disable(kind: BriefingKind): void;
  setTime(kind: BriefingKind, time: string): void;
}

/** Canonical schedule row name per kind. */
const SCHEDULE_NAME: Record<BriefingKind, string> = {
  morning: 'morning-briefing',
  evening: 'evening-briefing',
};

/** Default time used when enable() is called without a prior value. */
const DEFAULT_TIME: Record<BriefingKind, string> = {
  morning: '07:30',
  evening: '18:30',
};

/** Per-briefing daily token budget — plenty for a calendar + email sweep. */
const DEFAULT_BUDGET = 50_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(time: string): { hh: number; mm: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`invalid HH:MM time: "${time}"`);
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

export function timeToCron(time: string): string {
  const { hh, mm } = parseTime(time);
  return `${mm} ${hh} * * *`;
}

/**
 * Parse `M H * * *` back to `HH:MM`. Returns the `fallback` if the
 * expression doesn't look like a daily briefing cron.
 */
export function cronToTime(cron: string, fallback: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return fallback;
  const mm = Number(m);
  const hh = Number(h);
  if (!Number.isFinite(mm) || !Number.isFinite(hh)) return fallback;
  if (mm < 0 || mm > 59 || hh < 0 || hh > 23) return fallback;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function promptFor(kind: BriefingKind): string {
  return kind === 'morning' ? MORNING_BRIEFING_PROMPT : EVENING_BRIEFING_PROMPT;
}

function payloadFor(kind: BriefingKind): string {
  return JSON.stringify({ prompt: promptFor(kind) });
}

export interface BriefingManagerDeps {
  schedules: SchedulesRepo;
  /**
   * Called after any change so the scheduler engine re-reads state. Same
   * callback as `onSchedulesChanged` in the dashboard. Optional for
   * standalone-use test cases.
   */
  onChange?: () => void;
}

export function createBriefingManager(deps: BriefingManagerDeps): BriefingManager {
  function rowFor(kind: BriefingKind): ScheduleRecord | null {
    return deps.schedules.getByName(SCHEDULE_NAME[kind]);
  }

  function statusFor(kind: BriefingKind): BriefingStatus {
    const row = rowFor(kind);
    if (!row) {
      return { kind, enabled: false, time: DEFAULT_TIME[kind] };
    }
    return {
      kind,
      enabled: row.enabled === 1,
      time: cronToTime(row.cron_expr, DEFAULT_TIME[kind]),
    };
  }

  return {
    getStatus() {
      return { morning: statusFor('morning'), evening: statusFor('evening') };
    },
    enable(kind, time) {
      // Validate up front so we don't write garbage to the DB.
      const cron = timeToCron(time);
      const existing = rowFor(kind);
      if (existing) {
        deps.schedules.update(existing.id, { enabled: true, cron_expr: cron });
      } else {
        deps.schedules.create({
          name: SCHEDULE_NAME[kind],
          cron_expr: cron,
          kind: 'agent-task',
          payload: payloadFor(kind),
          enabled: true,
          recurring: true,
          budget_tokens_per_day: DEFAULT_BUDGET,
        });
      }
      deps.onChange?.();
    },
    disable(kind) {
      const existing = rowFor(kind);
      if (!existing) return;
      deps.schedules.update(existing.id, { enabled: false });
      deps.onChange?.();
    },
    setTime(kind, time) {
      const cron = timeToCron(time);
      const existing = rowFor(kind);
      if (!existing) {
        // Enabling semantics: setting a time for a not-yet-created row
        // creates it disabled. The operator still has to flip the
        // toggle to arm it.
        deps.schedules.create({
          name: SCHEDULE_NAME[kind],
          cron_expr: cron,
          kind: 'agent-task',
          payload: payloadFor(kind),
          enabled: false,
          recurring: true,
          budget_tokens_per_day: DEFAULT_BUDGET,
        });
      } else {
        deps.schedules.update(existing.id, { cron_expr: cron });
      }
      deps.onChange?.();
    },
  };
}
