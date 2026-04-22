import { readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { SessionsRepo } from '../db/repositories/sessions.js';

export interface WorkspaceCleanupDeps {
  logger: Logger;
  sessionsRepo: SessionsRepo;
  workspaceRoot: string;
  /** Minimum age of a directory before we consider removing it. Default: 24h. */
  minAgeMs?: number;
}

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Each agent session writes a per-session workspace directory at
 * `<workspaceRoot>/<session-id>/` containing the generated `.mcp.json`.
 * Without cleanup, this grows forever — we've seen ~3K dirs accumulate
 * after a year of daily use.
 *
 * Cleanup rules:
 *   - Ignore any dir whose name doesn't look like a UUID (we don't own it).
 *   - Ignore dirs younger than `minAgeMs` (active sessions or close-to-done).
 *   - For older dirs, look up the session in `sessions` — remove the dir
 *     if the session is in a terminal state (completed / failed / crashed /
 *     cancelled / orphaned). If the session row doesn't exist anymore
 *     (pruned DB) remove the dir too.
 *   - If the session is still `running` / `queued` (unlikely for >24h but
 *     possible), leave it alone.
 */
export function sweepSessionWorkspaces(deps: WorkspaceCleanupDeps): {
  scanned: number;
  removed: number;
  skipped: number;
} {
  const minAgeMs = deps.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const result = { scanned: 0, removed: 0, skipped: 0 };

  if (!existsSync(deps.workspaceRoot)) return result;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const now = Date.now();

  for (const entry of readdirSync(deps.workspaceRoot)) {
    if (!UUID_RE.test(entry)) continue; // not ours
    result.scanned += 1;

    const fullPath = resolve(deps.workspaceRoot, entry);
    let ageMs: number;
    try {
      ageMs = now - statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < minAgeMs) {
      result.skipped += 1;
      continue;
    }

    const session = deps.sessionsRepo.get(entry);
    const terminal =
      session === null ||
      ['completed', 'failed', 'crashed', 'cancelled', 'orphaned'].includes(
        session.status,
      );
    if (!terminal) {
      result.skipped += 1;
      continue;
    }

    try {
      rmSync(fullPath, { recursive: true, force: true });
      result.removed += 1;
    } catch (e) {
      deps.logger.warn(
        { err: (e as Error).message, dir: fullPath },
        'workspace cleanup: rm failed',
      );
    }
  }

  if (result.scanned > 0 || result.removed > 0) {
    deps.logger.info(result, 'workspace cleanup swept');
  }
  return result;
}
