-- Browser-skill import gate (Phase 2).
--
-- Holds short-lived authorization windows for storageState.json uploads.
-- The operator opens a window on the VPS:
--     andybioticlaw browser import-window open <profile> --ttl 5m
-- which inserts a row here. The dashboard's POST /api/browser/profiles/:name/import
-- route refuses any upload that doesn't match an open, unconsumed,
-- unexpired window. After a successful import the row's `consumed`
-- flag is set so the same window can't be re-used.
--
-- This is layered on top of (not in place of) basic auth — that route
-- additionally requires dashboard.basicAuth.enabled.

CREATE TABLE browser_import_windows (
  profile TEXT PRIMARY KEY,
  opened_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  consumed_checksum TEXT
);

CREATE INDEX idx_browser_import_windows_expires
  ON browser_import_windows(expires_at_ms);
