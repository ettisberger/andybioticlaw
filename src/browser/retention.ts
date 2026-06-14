import { statSync, unlinkSync, readdirSync, existsSync, rmdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { Database } from 'better-sqlite3';

/**
 * Browser activity retention sweep.
 *
 * Two passes:
 *   1. Delete `browser_events` rows older than retentionDays. SQLite
 *      reclaims the screenshot_path text but does NOT touch the files
 *      on disk (we can't trust that all referenced files still exist).
 *   2. Walk data/browser/screenshots/, sum file sizes, and if total
 *      exceeds retentionMb, delete the oldest files (LRU by mtime)
 *      until under the cap. Empty subdirs (yyyy-mm/session-id/) are
 *      then removed.
 *
 * Designed to be cheap when there's nothing to do. Logs a one-line
 * summary at info level when work happened, debug otherwise.
 */
export interface RetentionRunInput {
  db: Database;
  screenshotsDir: string;
  retentionDays: number;
  retentionMb: number;
  logger: Logger;
  now?: () => number;
}

export interface RetentionRunResult {
  rowsDeleted: number;
  filesDeleted: number;
  bytesBefore: number;
  bytesAfter: number;
}

export function runBrowserRetention(input: RetentionRunInput): RetentionRunResult {
  const now = (input.now ?? Date.now)();
  const cutoffMs = now - input.retentionDays * 24 * 60 * 60 * 1000;

  // ---- Pass 1: prune old DB rows. ----
  const stmt = input.db.prepare<[number]>(
    `DELETE FROM browser_events WHERE created_at_ms < ?`,
  );
  const rowsDeleted = stmt.run(cutoffMs).changes;

  // ---- Pass 2: prune screenshot files over the size cap. ----
  let filesDeleted = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  if (existsSync(input.screenshotsDir)) {
    const files = listAllPng(input.screenshotsDir).sort(
      (a, b) => a.mtimeMs - b.mtimeMs,
    );
    bytesBefore = files.reduce((sum, f) => sum + f.size, 0);
    const capBytes = input.retentionMb * 1024 * 1024;
    let total = bytesBefore;
    for (const f of files) {
      if (total <= capBytes) break;
      try {
        unlinkSync(f.path);
        total -= f.size;
        filesDeleted += 1;
      } catch {
        /* swallow — file may have been deleted concurrently */
      }
    }
    bytesAfter = total;
    pruneEmptyDirs(input.screenshotsDir);
  }

  const did = rowsDeleted > 0 || filesDeleted > 0;
  input.logger[did ? 'info' : 'debug'](
    {
      rowsDeleted,
      filesDeleted,
      bytesBefore,
      bytesAfter,
      cap: input.retentionMb,
    },
    'browser retention sweep',
  );

  return { rowsDeleted, filesDeleted, bytesBefore, bytesAfter };
}

interface ScreenshotFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function listAllPng(root: string): ScreenshotFile[] {
  const out: ScreenshotFile[] = [];
  function recurse(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        recurse(full);
      } else if (e.isFile() && e.name.endsWith('.png')) {
        try {
          const st = statSync(full);
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* swallow */
        }
      }
    }
  }
  recurse(root);
  return out;
}

function pruneEmptyDirs(root: string): void {
  function recurse(dir: string): boolean {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let hasContent = false;
    for (const e of entries) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        const childHasContent = recurse(full);
        if (childHasContent) hasContent = true;
      } else {
        hasContent = true;
      }
    }
    if (!hasContent && dir !== root) {
      try {
        rmdirSync(dir);
      } catch {
        /* swallow */
      }
    }
    return hasContent;
  }
  recurse(root);
}
