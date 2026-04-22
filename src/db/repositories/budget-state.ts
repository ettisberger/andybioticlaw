import type { Database } from 'better-sqlite3';

/**
 * Single-row KV for budget overrides. The only field today is the manual
 * daily-reset anchor — a timestamp that shifts the effective start of the
 * current budget window when it's newer than the natural (cron-based) start.
 *
 * We guarantee the row exists via the migration's `INSERT OR IGNORE`, so
 * the repo never has to deal with the "no row yet" case. `setResetAnchor`
 * updates in place.
 */
export interface BudgetStateRepo {
  /** Returns the manual reset anchor in epoch ms, or null if none set. */
  getResetAnchor(): number | null;
  /** Replaces (or clears, when `ms === null`) the manual reset anchor. */
  setResetAnchor(ms: number | null): void;
}

export function createBudgetStateRepo(db: Database): BudgetStateRepo {
  const select = db.prepare<[], { daily_reset_anchor_ms: number | null }>(
    `SELECT daily_reset_anchor_ms FROM budget_state WHERE id = 1`,
  );
  const update = db.prepare<{ ms: number | null }>(
    `UPDATE budget_state SET daily_reset_anchor_ms = @ms WHERE id = 1`,
  );
  return {
    getResetAnchor() {
      const row = select.get();
      return row?.daily_reset_anchor_ms ?? null;
    },
    setResetAnchor(ms) {
      update.run({ ms });
    },
  };
}
