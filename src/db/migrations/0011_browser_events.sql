-- Browser-skill activity log (Phase 3).
--
-- One row per tool call to the `browser` MCP server. The recorder in
-- skills/browser/mcp-server/src/recorder.js writes here on every dispatch.
-- The dashboard's GET /api/browser/sessions + /events endpoints read here.
--
-- Retention is enforced by a cron in src/index.ts: rows older than
-- `browser.dashboard.retentionDays` are deleted; screenshot files
-- (referenced by `screenshot_path`) are pruned separately to stay
-- under `browser.dashboard.retentionMb` total.

CREATE TABLE browser_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  action TEXT NOT NULL,
  target_url TEXT,
  ref_or_selector TEXT,
  outcome TEXT NOT NULL,   -- 'ok' | 'error' | 'blocked'
  error_message TEXT,
  screenshot_path TEXT,
  created_at_ms INTEGER NOT NULL
);

-- Per-session timeline lookups are the dashboard's primary query.
CREATE INDEX idx_browser_events_session
  ON browser_events(session_id, created_at_ms DESC);

-- Used by the recent-sessions list + retention cleanup.
CREATE INDEX idx_browser_events_created
  ON browser_events(created_at_ms DESC);
