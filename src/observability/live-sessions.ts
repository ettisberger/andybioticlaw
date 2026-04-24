/**
 * In-memory tracker for currently-running agent sessions. Populated by
 * `session.executeSession` as the Claude CLI streams back tokens and tool
 * uses; read by the dashboard's `/api/sessions/live` endpoints so the
 * operator can see what Emma is doing *right now* without waiting for
 * session end.
 *
 * Why in-memory, not a DB table:
 *   - A "live" row is only meaningful while the process is up. Restarts
 *     kill every running session anyway (the child Claude CLIs are gone),
 *     so there is nothing to recover.
 *   - The stream is high-frequency (text deltas every few ms). Writing
 *     each delta to SQLite would be pure write amplification for data
 *     that's already aggregated into `sessions.tokens_output` at end.
 *
 * Bounded memory: at most one entry per concurrent session, cleaned up in
 * `end()`. Accumulated text is capped at {@link MAX_TEXT_CHARS} — past
 * that we drop leading chars and keep a "…" marker so the total never
 * exceeds the cap even for very long replies.
 */

/** Hard cap on the per-session accumulated text in memory. */
export const MAX_TEXT_CHARS = 16_384;

export interface LiveSessionState {
  sessionId: string;
  chatId: string;
  source: 'dm' | 'group' | 'schedule' | 'api';
  /** Millis since epoch when executeSession kicked off. */
  startedAt: number;
  /** Millis since epoch of the last text delta (null if none yet). */
  lastDeltaAt: number | null;
  /** Aggregated streamed text — may be truncated from the front with a `…` prefix. */
  text: string;
  /** Tool-use names observed, in order. Repeats allowed (e.g. two list_events calls). */
  toolUses: string[];
  /** True if text was truncated due to MAX_TEXT_CHARS. */
  truncated: boolean;
}

export interface LiveSessionsTracker {
  start(input: {
    sessionId: string;
    chatId: string;
    source: 'dm' | 'group' | 'schedule' | 'api';
  }): void;
  onDelta(sessionId: string, text: string): void;
  onToolUse(sessionId: string, name: string): void;
  end(sessionId: string): void;
  snapshot(): LiveSessionState[];
  snapshotOne(sessionId: string): LiveSessionState | null;
}

export function createLiveSessionsTracker(): LiveSessionsTracker {
  const sessions = new Map<string, LiveSessionState>();

  return {
    start(input) {
      sessions.set(input.sessionId, {
        sessionId: input.sessionId,
        chatId: input.chatId,
        source: input.source,
        startedAt: Date.now(),
        lastDeltaAt: null,
        text: '',
        toolUses: [],
        truncated: false,
      });
    },

    onDelta(sessionId, text) {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.lastDeltaAt = Date.now();
      const combined = s.text + text;
      if (combined.length > MAX_TEXT_CHARS) {
        // Drop the oldest chars; keep the last MAX_TEXT_CHARS-1 and a
        // leading "…" marker so the consumer can tell it's truncated.
        s.text = '…' + combined.slice(-(MAX_TEXT_CHARS - 1));
        s.truncated = true;
      } else {
        s.text = combined;
      }
    },

    onToolUse(sessionId, name) {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.toolUses.push(name);
    },

    end(sessionId) {
      sessions.delete(sessionId);
    },

    snapshot() {
      // Shallow copies so callers can't mutate internal state.
      return Array.from(sessions.values(), (s) => ({ ...s, toolUses: [...s.toolUses] }));
    },

    snapshotOne(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return { ...s, toolUses: [...s.toolUses] };
    },
  };
}
