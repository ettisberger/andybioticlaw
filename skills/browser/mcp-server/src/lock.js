/**
 * Per-profile mutex.
 *
 * Two simultaneous sessions on the same Chromium user-data-dir corrupt
 * the SQLite files Chromium uses for cookies + IndexedDB. We serialize
 * via an in-memory mutex that fails FAST (no queue) — the caller hears
 * "profile X is in use" and can decide to retry or escalate.
 *
 * Two release triggers:
 *   - Caller calls release() (normal happy path, on session end).
 *   - 10-min wall-clock watchdog (covers OOM-killed sessions / crashes
 *     where release() never runs and the profile would otherwise be
 *     locked forever).
 */

const WATCHDOG_MS = 10 * 60 * 1000;

export class ProfileLockBusyError extends Error {
  constructor(profile, holder) {
    super(
      `profile '${profile}' is in use by session '${holder.sessionId}' ` +
        `running '${holder.tool}' for ${Math.floor((Date.now() - holder.startedAt) / 1000)}s`,
    );
    this.name = 'ProfileLockBusyError';
    this.profile = profile;
    this.holder = holder;
  }
}

export class ProfileLockManager {
  constructor() {
    /** @type {Map<string, { sessionId: string; startedAt: number; tool: string; watchdog: NodeJS.Timeout }>} */
    this.holders = new Map();
  }

  /**
   * Try to acquire `profile` for `sessionId` doing `tool`. Throws
   * ProfileLockBusyError if held. Caller MUST call release() to free
   * (otherwise the watchdog will reclaim it after WATCHDOG_MS).
   */
  acquire(profile, sessionId, tool) {
    const held = this.holders.get(profile);
    if (held) {
      // Same session re-acquiring (e.g. nested tool dispatch) is fine —
      // the mutex protects against cross-session collision, not nesting.
      if (held.sessionId === sessionId) {
        held.tool = tool;
        return;
      }
      throw new ProfileLockBusyError(profile, held);
    }
    const startedAt = Date.now();
    const watchdog = setTimeout(() => {
      if (this.holders.get(profile)?.startedAt === startedAt) {
        this.holders.delete(profile);
      }
    }, WATCHDOG_MS);
    // Detach the timer from event-loop liveness so it doesn't keep
    // the process alive past everything else.
    watchdog.unref?.();
    this.holders.set(profile, { sessionId, startedAt, tool, watchdog });
  }

  /**
   * Release `profile` if currently held by `sessionId`. No-op if it's
   * held by someone else (defensive — don't let a stale release()
   * steal someone else's lock).
   */
  release(profile, sessionId) {
    const held = this.holders.get(profile);
    if (!held || held.sessionId !== sessionId) return;
    clearTimeout(held.watchdog);
    this.holders.delete(profile);
  }

  /** Release everything (used in supervisor's `unhandledRejection` exit path). */
  releaseAll() {
    for (const held of this.holders.values()) clearTimeout(held.watchdog);
    this.holders.clear();
  }

  /** For tests / dashboards. */
  status() {
    return Array.from(this.holders.entries()).map(([profile, h]) => ({
      profile,
      sessionId: h.sessionId,
      tool: h.tool,
      heldForMs: Date.now() - h.startedAt,
    }));
  }
}
