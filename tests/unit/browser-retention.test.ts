import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { runBrowserRetention } from '../../src/browser/retention.js';

const SILENT = pino({ level: 'silent' });

describe('runBrowserRetention', () => {
  let dir: string;
  let handle: ReturnType<typeof openDatabase>;
  let screenshotsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-retn-'));
    handle = openDatabase(resolve(dir, 'test.db'), SILENT);
    screenshotsDir = resolve(dir, 'browser/screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertEvent(createdAtMs: number) {
    handle.db
      .prepare(
        `INSERT INTO browser_events (session_id, profile, action, target_url, ref_or_selector, outcome, error_message, screenshot_path, created_at_ms)
         VALUES ('s', 'p', 'browser_navigate', NULL, NULL, 'ok', NULL, NULL, ?)`,
      )
      .run(createdAtMs);
  }

  function writeScreenshot(name: string, bytes: number, ageMs = 0): string {
    const sub = resolve(screenshotsDir, '2026-01', 's');
    mkdirSync(sub, { recursive: true });
    const path = resolve(sub, name);
    writeFileSync(path, Buffer.alloc(bytes));
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(path, t, t);
    }
    return path;
  }

  it('deletes events older than retentionDays', () => {
    const now = Date.now();
    insertEvent(now - 30 * 24 * 60 * 60 * 1000); // 30d old
    insertEvent(now - 1 * 24 * 60 * 60 * 1000);  //  1d old
    const result = runBrowserRetention({
      db: handle.db,
      screenshotsDir,
      retentionDays: 7,
      retentionMb: 50,
      logger: SILENT,
    });
    expect(result.rowsDeleted).toBe(1);
    const remaining = handle.db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM browser_events')
      .get();
    expect(remaining?.c).toBe(1);
  });

  it('keeps everything when retention is large', () => {
    const now = Date.now();
    insertEvent(now - 30 * 24 * 60 * 60 * 1000);
    const result = runBrowserRetention({
      db: handle.db,
      screenshotsDir,
      retentionDays: 365,
      retentionMb: 50,
      logger: SILENT,
    });
    expect(result.rowsDeleted).toBe(0);
  });

  it('prunes oldest screenshots first when over the size cap', () => {
    // 3 files at 1 MB each; cap = 2 MB → oldest 1 should be deleted.
    const oldest = writeScreenshot('a.png', 1024 * 1024, 10_000);
    const middle = writeScreenshot('b.png', 1024 * 1024, 5_000);
    const newest = writeScreenshot('c.png', 1024 * 1024, 0);
    const result = runBrowserRetention({
      db: handle.db,
      screenshotsDir,
      retentionDays: 365,
      retentionMb: 2,
      logger: SILENT,
    });
    expect(result.filesDeleted).toBe(1);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('is a no-op when under the cap', () => {
    writeScreenshot('a.png', 1024); // 1 KB
    const result = runBrowserRetention({
      db: handle.db,
      screenshotsDir,
      retentionDays: 365,
      retentionMb: 50,
      logger: SILENT,
    });
    expect(result.filesDeleted).toBe(0);
  });
});
