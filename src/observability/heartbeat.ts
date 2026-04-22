import type { Logger } from 'pino';
import type { HeartbeatsRepo, HeartbeatMeta } from '../db/repositories/heartbeats.js';

export interface HeartbeatDriverDeps {
  repo: HeartbeatsRepo;
  logger: Logger;
  /** Called each tick to snapshot current live state (Phase 2+ provides real data). */
  snapshot: () => HeartbeatMeta;
  /** Returns the current interval in ms. Called each tick so hot-reload is picked up. */
  intervalMs: () => number;
  /** Retention cutoff (in ms). Rows older than `now - retention` are trimmed once per day. */
  retentionMs: () => number;
}

export interface HeartbeatDriver {
  start(): void;
  stop(): void;
  /** Run one tick synchronously (useful for tests and for the startup log line). */
  tickNow(): void;
}

/**
 * Writes a heartbeat row at each tick. Also does a lazy retention cleanup
 * (once per day, using last-clean tracking) so we don't need a separate
 * scheduler job in Phase 1.
 */
export function createHeartbeatDriver(deps: HeartbeatDriverDeps): HeartbeatDriver {
  let timer: NodeJS.Timeout | null = null;
  let lastCleanupAt = 0;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  function tickNow() {
    const meta = deps.snapshot();
    deps.repo.write(meta);

    const now = Date.now();
    if (now - lastCleanupAt > ONE_DAY_MS) {
      const removed = deps.repo.deleteOlderThan(now - deps.retentionMs());
      if (removed > 0) deps.logger.debug({ removed }, 'heartbeat retention cleanup');
      lastCleanupAt = now;
    }
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    // Intentionally NOT unref'd: the heartbeat is our "service is alive"
    // anchor. Without it, a Phase 1 boot (no Telegram bot, no HTTP listener)
    // would have nothing keeping the event loop alive and the process would
    // exit immediately after `ready`. Later phases add long-lived resources
    // that would also anchor the loop, but we still want the heartbeat to
    // keep ticking even if they shut down.
    timer = setTimeout(() => {
      try {
        tickNow();
      } catch (e) {
        deps.logger.warn({ err: (e as Error).message }, 'heartbeat tick failed');
      }
      scheduleNext();
    }, deps.intervalMs());
  }

  return {
    start() {
      tickNow();
      scheduleNext();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tickNow,
  };
}
