import type { Database } from 'better-sqlite3';

// Phase 1: stub. Full API lands with Phase 4 (scheduler engine with per-kind
// handlers, loop-protection, daily budget reset, auto-disable thresholds).
export interface SchedulesRepo {
  readonly db: Database;
}

export function createSchedulesRepo(db: Database): SchedulesRepo {
  return { db };
}
