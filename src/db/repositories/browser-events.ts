import type { Database } from 'better-sqlite3';

export interface BrowserEvent {
  id: number;
  sessionId: string;
  profile: string;
  action: string;
  targetUrl: string | null;
  refOrSelector: string | null;
  outcome: string;
  errorMessage: string | null;
  screenshotPath: string | null;
  createdAtMs: number;
}

export interface BrowserSessionSummary {
  sessionId: string;
  firstEventMs: number;
  lastEventMs: number;
  eventCount: number;
  profiles: string[];
  okCount: number;
  errorCount: number;
}

export interface BrowserEventsRepo {
  /** Recent sessions touched by browser activity (newest first). */
  listSessions(limit: number): BrowserSessionSummary[];
  /** All events for a session, oldest first. */
  listForSession(sessionId: string): BrowserEvent[];
  /** Delete rows older than the given timestamp. Returns the count removed. */
  deleteOlderThan(beforeMs: number): number;
  /** Screenshot paths in created-at order — used by the retention sweep
   *  to delete oldest files until the dir is under quota. */
  listScreenshotPaths(): Array<{ path: string; createdAtMs: number }>;
  /** Clear a screenshot_path on a single row (after the file has been deleted). */
  clearScreenshot(id: number): void;
}

function rowToEvent(row: {
  id: number;
  session_id: string;
  profile: string;
  action: string;
  target_url: string | null;
  ref_or_selector: string | null;
  outcome: string;
  error_message: string | null;
  screenshot_path: string | null;
  created_at_ms: number;
}): BrowserEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    profile: row.profile,
    action: row.action,
    targetUrl: row.target_url,
    refOrSelector: row.ref_or_selector,
    outcome: row.outcome,
    errorMessage: row.error_message,
    screenshotPath: row.screenshot_path,
    createdAtMs: row.created_at_ms,
  };
}

export function createBrowserEventsRepo(db: Database): BrowserEventsRepo {
  const sessionsStmt = db.prepare<[number]>(
    `SELECT session_id,
            MIN(created_at_ms) AS first_event_ms,
            MAX(created_at_ms) AS last_event_ms,
            COUNT(*)            AS event_count,
            GROUP_CONCAT(DISTINCT profile) AS profiles,
            SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END)    AS ok_count,
            SUM(CASE WHEN outcome != 'ok' THEN 1 ELSE 0 END)   AS error_count
       FROM browser_events
      GROUP BY session_id
      ORDER BY last_event_ms DESC
      LIMIT ?`,
  );
  const forSessionStmt = db.prepare<[string]>(
    `SELECT id, session_id, profile, action, target_url, ref_or_selector,
            outcome, error_message, screenshot_path, created_at_ms
       FROM browser_events
      WHERE session_id = ?
      ORDER BY created_at_ms ASC, id ASC`,
  );
  const deleteOlderStmt = db.prepare<[number]>(
    `DELETE FROM browser_events WHERE created_at_ms < ?`,
  );
  const screenshotPathsStmt = db.prepare(
    `SELECT id, screenshot_path AS path, created_at_ms AS createdAtMs
       FROM browser_events
      WHERE screenshot_path IS NOT NULL
      ORDER BY created_at_ms ASC`,
  );
  const clearScreenshotStmt = db.prepare<[number]>(
    `UPDATE browser_events SET screenshot_path = NULL WHERE id = ?`,
  );

  return {
    listSessions(limit) {
      const rows = sessionsStmt.all(limit) as Array<{
        session_id: string;
        first_event_ms: number;
        last_event_ms: number;
        event_count: number;
        profiles: string | null;
        ok_count: number;
        error_count: number;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        firstEventMs: r.first_event_ms,
        lastEventMs: r.last_event_ms,
        eventCount: r.event_count,
        profiles: r.profiles ? r.profiles.split(',').filter(Boolean) : [],
        okCount: r.ok_count,
        errorCount: r.error_count,
      }));
    },
    listForSession(sessionId) {
      const rows = forSessionStmt.all(sessionId) as Array<{
        id: number;
        session_id: string;
        profile: string;
        action: string;
        target_url: string | null;
        ref_or_selector: string | null;
        outcome: string;
        error_message: string | null;
        screenshot_path: string | null;
        created_at_ms: number;
      }>;
      return rows.map(rowToEvent);
    },
    deleteOlderThan(beforeMs) {
      return deleteOlderStmt.run(beforeMs).changes;
    },
    listScreenshotPaths() {
      const rows = screenshotPathsStmt.all() as Array<{
        id: number;
        path: string;
        createdAtMs: number;
      }>;
      // id is also returned so the caller can clear the FK after deletion,
      // but for retention we only need (path, createdAtMs).
      return rows.map((r) => ({ path: r.path, createdAtMs: r.createdAtMs }));
    },
    clearScreenshot(id) {
      clearScreenshotStmt.run(id);
    },
  };
}
