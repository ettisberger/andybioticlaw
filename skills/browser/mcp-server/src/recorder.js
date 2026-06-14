/**
 * Activity recorder — writes a row per tool call to `browser_events` and
 * (when enabled) captures a per-step screenshot under
 * `data/browser/screenshots/<yyyy-mm>/<session-id>/`.
 *
 * Phase 1 ships with the recorder live but the migration creating the
 * `browser_events` table only lands in Phase 3. The recorder probes for
 * the table on construction; if absent (Phase 1 install), it falls back
 * to a no-op so missing migrations don't crash the server. The
 * dashboard page (Phase 3) is a separate concern.
 *
 * Screenshot suppression: if a tool call resolved a `{{SECRET}}`
 * placeholder, the recorder skips the screenshot for THAT action even
 * if global capture is on. The DOM still holds the secret at this
 * moment; capturing would leak it into the screenshot file.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const ENV_DB_PATH = 'ANDYBIOTICLAW_DB_PATH';
const ENV_SESSION_ID = 'ANDYBIOTICLAW_SESSION_ID';

const SCREENSHOT_BY_DEFAULT = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press_key',
  'browser_back',
  'browser_forward',
  'browser_reload',
]);

/**
 * Resolve better-sqlite3 from the parent project's node_modules. The
 * MCP server lives under skills/browser/mcp-server/ and the package
 * doesn't ship a copy — but the parent always has it.
 */
function loadSqlite() {
  try {
    const require = createRequire(import.meta.url);
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

export class Recorder {
  /**
   * @param {object} opts
   * @param {string} opts.screenshotsDir
   * @param {boolean} opts.screenshotOnSnapshot — extends defaults
   */
  constructor(opts) {
    this.screenshotsDir = opts.screenshotsDir;
    this.screenshotOnSnapshot = !!opts.screenshotOnSnapshot;
    this.sessionId = process.env[ENV_SESSION_ID] || '';
    this.dbPath = process.env[ENV_DB_PATH] || '';
    this.db = null;
    this.insertStmt = null;
    this.enabled = false;

    if (this.sessionId && this.dbPath) {
      const Sqlite = loadSqlite();
      if (Sqlite) {
        try {
          this.db = new Sqlite(this.dbPath, { readonly: false });
          // Probe for the table (Phase 3 migration adds it).
          const row = this.db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='browser_events'`,
            )
            .get();
          if (row) {
            this.insertStmt = this.db.prepare(
              `INSERT INTO browser_events
               (session_id, profile, action, target_url, ref_or_selector, outcome, error_message, screenshot_path, created_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            this.enabled = true;
          }
        } catch {
          /* recorder is optional — fall back to no-op */
        }
      }
    }
  }

  shouldScreenshot(action) {
    if (action === 'browser_snapshot') return this.screenshotOnSnapshot;
    if (action === 'browser_screenshot') return false; // explicit return value
    if (action === 'browser_wait') return false;
    return SCREENSHOT_BY_DEFAULT.has(action);
  }

  /**
   * @param {object} input
   * @param {string} input.action
   * @param {string} input.profile
   * @param {string | null} input.targetUrl
   * @param {string | null} input.refOrSelector
   * @param {'ok' | 'error' | 'blocked'} input.outcome
   * @param {string | null} input.errorMessage
   * @param {Buffer | null} input.screenshotBuffer  — image bytes (we own the write)
   * @param {boolean} input.usedSecret — if true, skip screenshot persistence
   */
  record(input) {
    if (!this.enabled) return;
    let screenshotPath = null;
    if (input.screenshotBuffer && !input.usedSecret) {
      try {
        const now = new Date(Date.now());
        const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const dir = resolve(this.screenshotsDir, yyyymm, this.sessionId);
        mkdirSync(dir, { recursive: true });
        const filename = `${Date.now()}-${input.action}.png`;
        const fullPath = resolve(dir, filename);
        try {
          writeFileSync(fullPath, input.screenshotBuffer, { mode: 0o600 });
          screenshotPath = fullPath;
        } catch {
          /* recorder failures are non-fatal */
        }
      } catch {
        /* swallow */
      }
    }
    try {
      this.insertStmt.run(
        this.sessionId,
        input.profile,
        input.action,
        input.targetUrl,
        input.refOrSelector,
        input.outcome,
        input.errorMessage,
        screenshotPath,
        Date.now(),
      );
    } catch {
      /* swallow */
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* swallow */
    }
  }
}
