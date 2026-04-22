import type { Database } from 'better-sqlite3';
import type { ScheduleKind } from '../../scheduler/payloads.js';

export interface ScheduleRecord {
  id: number;
  name: string;
  cron_expr: string;
  kind: ScheduleKind;
  payload: string; // JSON string
  enabled: 0 | 1;
  budget_tokens_per_day: number | null;
  budget_used_today: number;
  budget_reset_at: number | null;
  last_run: number | null;
  next_run: number | null;
  consecutive_fails: number;
  created_at: number;
}

export interface CreateScheduleInput {
  name: string;
  cron_expr: string;
  kind: ScheduleKind;
  payload: string; // JSON string
  enabled?: boolean;
  budget_tokens_per_day?: number | null;
}

export interface UpdateScheduleInput {
  cron_expr?: string;
  payload?: string;
  enabled?: boolean;
  budget_tokens_per_day?: number | null;
  last_run?: number;
  next_run?: number | null;
  consecutive_fails?: number;
  budget_used_today?: number;
  budget_reset_at?: number | null;
}

export type ScheduleRunStatus = 'success' | 'fail' | 'skipped';

export interface ScheduleRunRecord {
  id: number;
  schedule_id: number;
  started_at: number;
  ended_at: number | null;
  status: ScheduleRunStatus;
  output: string | null;
  tokens_used: number;
}

export interface RecordRunInput {
  schedule_id: number;
  started_at: number;
  ended_at: number;
  status: ScheduleRunStatus;
  output?: string;
  tokens_used?: number;
}

export interface SchedulesRepo {
  create(input: CreateScheduleInput): ScheduleRecord;
  update(id: number, patch: UpdateScheduleInput): void;
  get(id: number): ScheduleRecord | null;
  getByName(name: string): ScheduleRecord | null;
  list(opts?: { enabledOnly?: boolean }): ScheduleRecord[];
  remove(id: number): boolean;

  recordRun(input: RecordRunInput): number;
  listRuns(scheduleId: number, limit?: number): ScheduleRunRecord[];
  countRunsSince(scheduleId: number, sinceMs: number): number;

  incrementBudget(id: number, tokens: number): void;
  resetBudgetIfStale(id: number, windowStartMs: number): void;
}

/** Allowlist of columns accepted by `SchedulesRepo.update()`. Interpolated
 *  into SQL, so must be kept in sync with `UpdateScheduleInput`. */
const ALLOWED_SCHEDULE_UPDATE_KEYS: readonly (keyof UpdateScheduleInput)[] = [
  'cron_expr',
  'payload',
  'enabled',
  'budget_tokens_per_day',
  'last_run',
  'next_run',
  'consecutive_fails',
  'budget_used_today',
  'budget_reset_at',
];

export function createSchedulesRepo(db: Database): SchedulesRepo {
  const insert = db.prepare(
    `INSERT INTO schedules (name, cron_expr, kind, payload, enabled, budget_tokens_per_day, budget_used_today, created_at)
     VALUES (@name, @cron_expr, @kind, @payload, @enabled, @budget_tokens_per_day, 0, @created_at)`,
  );
  const selectOne = db.prepare<{ id: number }, ScheduleRecord>(
    `SELECT * FROM schedules WHERE id = @id`,
  );
  const selectByName = db.prepare<{ name: string }, ScheduleRecord>(
    `SELECT * FROM schedules WHERE name = @name`,
  );
  const selectAll = db.prepare<[], ScheduleRecord>(
    `SELECT * FROM schedules ORDER BY id ASC`,
  );
  const selectEnabled = db.prepare<[], ScheduleRecord>(
    `SELECT * FROM schedules WHERE enabled = 1 ORDER BY id ASC`,
  );
  const deleteOne = db.prepare<{ id: number }>(`DELETE FROM schedules WHERE id = @id`);

  const insertRun = db.prepare(
    `INSERT INTO schedule_runs (schedule_id, started_at, ended_at, status, output, tokens_used)
     VALUES (@schedule_id, @started_at, @ended_at, @status, @output, @tokens_used)`,
  );
  const selectRuns = db.prepare<
    { schedule_id: number; limit: number },
    ScheduleRunRecord
  >(
    `SELECT * FROM schedule_runs WHERE schedule_id = @schedule_id ORDER BY started_at DESC LIMIT @limit`,
  );
  const countRecent = db.prepare<
    { schedule_id: number; since: number },
    { n: number }
  >(
    `SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = @schedule_id AND started_at >= @since`,
  );

  const incBudget = db.prepare<{ id: number; tokens: number }>(
    `UPDATE schedules SET budget_used_today = budget_used_today + @tokens WHERE id = @id`,
  );
  const resetBudget = db.prepare<{ id: number; reset_at: number }>(
    `UPDATE schedules SET budget_used_today = 0, budget_reset_at = @reset_at WHERE id = @id AND (budget_reset_at IS NULL OR budget_reset_at < @reset_at)`,
  );

  return {
    create(input) {
      const now = Date.now();
      const result = insert.run({
        name: input.name,
        cron_expr: input.cron_expr,
        kind: input.kind,
        payload: input.payload,
        enabled: input.enabled === false ? 0 : 1,
        budget_tokens_per_day: input.budget_tokens_per_day ?? null,
        created_at: now,
      });
      const row = selectOne.get({ id: Number(result.lastInsertRowid) });
      if (!row) throw new Error('schedule insert succeeded but row not found');
      return row;
    },
    update(id, patch) {
      const fields: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        // Keys land in SQL directly; reject anything outside the allowlist.
        if (!(ALLOWED_SCHEDULE_UPDATE_KEYS as readonly string[]).includes(k)) continue;
        if (k === 'enabled') {
          fields.push(`enabled = @enabled`);
          params['enabled'] = v ? 1 : 0;
        } else {
          fields.push(`${k} = @${k}`);
          params[k] = v;
        }
      }
      if (fields.length === 0) return;
      db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = @id`).run(params);
    },
    get(id) {
      return selectOne.get({ id }) ?? null;
    },
    getByName(name) {
      return selectByName.get({ name }) ?? null;
    },
    list({ enabledOnly = false } = {}) {
      return enabledOnly ? selectEnabled.all() : selectAll.all();
    },
    remove(id) {
      return deleteOne.run({ id }).changes > 0;
    },
    recordRun(input) {
      const result = insertRun.run({
        schedule_id: input.schedule_id,
        started_at: input.started_at,
        ended_at: input.ended_at,
        status: input.status,
        output: input.output ?? null,
        tokens_used: input.tokens_used ?? 0,
      });
      return Number(result.lastInsertRowid);
    },
    listRuns(scheduleId, limit = 20) {
      return selectRuns.all({ schedule_id: scheduleId, limit });
    },
    countRunsSince(scheduleId, sinceMs) {
      const row = countRecent.get({ schedule_id: scheduleId, since: sinceMs });
      return row?.n ?? 0;
    },
    incrementBudget(id, tokens) {
      incBudget.run({ id, tokens });
    },
    resetBudgetIfStale(id, windowStartMs) {
      resetBudget.run({ id, reset_at: windowStartMs });
    },
  };
}
