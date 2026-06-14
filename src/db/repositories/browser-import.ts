import type { Database } from 'better-sqlite3';

/**
 * Persistent short-lived authorization windows for browser storageState
 * uploads. The CLI inserts; the dashboard route reads + marks consumed.
 *
 * Single-row-per-profile model: opening a window for a profile while
 * one is already open just refreshes the expiry. Simpler than a
 * collection — the operator should never need two windows simultaneously.
 */

export interface BrowserImportWindow {
  profile: string;
  openedAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
  consumedChecksum: string | null;
}

export interface BrowserImportRepo {
  open(profile: string, ttlMs: number): BrowserImportWindow;
  close(profile: string): boolean;
  /**
   * Return the OPEN, NOT-YET-CONSUMED, NOT-YET-EXPIRED window for a
   * profile — or null if none. Used by the dashboard upload route as
   * the auth gate.
   */
  findOpen(profile: string, nowMs: number): BrowserImportWindow | null;
  /** Mark the window consumed. Idempotent on the checksum field. */
  consume(profile: string, checksum: string, nowMs: number): void;
  /** All rows, for `browser import-window status`. */
  list(): BrowserImportWindow[];
  /** Best-effort cleanup of long-expired rows. */
  cleanupExpired(beforeMs: number): number;
}

function rowToWindow(row: {
  profile: string;
  opened_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
  consumed_checksum: string | null;
}): BrowserImportWindow {
  return {
    profile: row.profile,
    openedAtMs: row.opened_at_ms,
    expiresAtMs: row.expires_at_ms,
    consumedAtMs: row.consumed_at_ms,
    consumedChecksum: row.consumed_checksum,
  };
}

export function createBrowserImportRepo(db: Database): BrowserImportRepo {
  const insertStmt = db.prepare<[string, number, number]>(
    `INSERT INTO browser_import_windows
       (profile, opened_at_ms, expires_at_ms, consumed_at_ms, consumed_checksum)
     VALUES (?, ?, ?, NULL, NULL)
     ON CONFLICT(profile) DO UPDATE SET
       opened_at_ms = excluded.opened_at_ms,
       expires_at_ms = excluded.expires_at_ms,
       consumed_at_ms = NULL,
       consumed_checksum = NULL`,
  );
  const selectStmt = db.prepare<[string]>(
    `SELECT profile, opened_at_ms, expires_at_ms, consumed_at_ms, consumed_checksum
       FROM browser_import_windows WHERE profile = ?`,
  );
  const deleteStmt = db.prepare<[string]>(
    `DELETE FROM browser_import_windows WHERE profile = ?`,
  );
  const consumeStmt = db.prepare<[number, string, string]>(
    `UPDATE browser_import_windows
       SET consumed_at_ms = ?, consumed_checksum = ?
     WHERE profile = ?`,
  );
  const listStmt = db.prepare(
    `SELECT profile, opened_at_ms, expires_at_ms, consumed_at_ms, consumed_checksum
       FROM browser_import_windows ORDER BY opened_at_ms DESC`,
  );
  const cleanupStmt = db.prepare<[number]>(
    `DELETE FROM browser_import_windows
        WHERE expires_at_ms < ? OR consumed_at_ms IS NOT NULL`,
  );

  return {
    open(profile, ttlMs) {
      const now = Date.now();
      const expires = now + ttlMs;
      insertStmt.run(profile, now, expires);
      return rowToWindow(selectStmt.get(profile) as never);
    },
    close(profile) {
      const r = deleteStmt.run(profile);
      return r.changes > 0;
    },
    findOpen(profile, nowMs) {
      const row = selectStmt.get(profile) as
        | {
            profile: string;
            opened_at_ms: number;
            expires_at_ms: number;
            consumed_at_ms: number | null;
            consumed_checksum: string | null;
          }
        | undefined;
      if (!row) return null;
      if (row.consumed_at_ms !== null) return null;
      if (row.expires_at_ms < nowMs) return null;
      return rowToWindow(row);
    },
    consume(profile, checksum, nowMs) {
      consumeStmt.run(nowMs, checksum, profile);
    },
    list() {
      const rows = listStmt.all() as Array<{
        profile: string;
        opened_at_ms: number;
        expires_at_ms: number;
        consumed_at_ms: number | null;
        consumed_checksum: string | null;
      }>;
      return rows.map(rowToWindow);
    },
    cleanupExpired(beforeMs) {
      const r = cleanupStmt.run(beforeMs);
      return r.changes;
    },
  };
}
