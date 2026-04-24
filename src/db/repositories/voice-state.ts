import type { Database } from 'better-sqlite3';

/**
 * Single-row KV for voice-input feature state. Mirrors {@link BudgetStateRepo}
 * in shape (single row, `id = 1` guard, migration pre-inserts it).
 *
 * Lives in SQLite rather than `.env` so the operator can flip it from
 * the CLI menu *without* a service restart — the DM handler reads
 * `getEnabled()` on every incoming voice message. `.env` changes need
 * a restart today; we didn't want that UX for a frequently-toggled knob.
 *
 * The actual Groq API key is separate — it lives in `.env` as
 * `GROQ_API_KEY` and is declared in `CORE_SECRETS`. Enabled=true without
 * a key still means "disabled at runtime" (the handler double-checks).
 */
export interface VoiceStateRepo {
  getEnabled(): boolean;
  /** Returns the last-updated timestamp in epoch ms. Useful for the menu status line. */
  getUpdatedAt(): number;
  /** Sets the enabled flag. Bumps `updated_at`. */
  setEnabled(enabled: boolean, now?: number): void;
}

export function createVoiceStateRepo(db: Database): VoiceStateRepo {
  const select = db.prepare<[], { enabled: number; updated_at: number }>(
    `SELECT enabled, updated_at FROM voice_state WHERE id = 1`,
  );
  const update = db.prepare<{ enabled: number; updated_at: number }>(
    `UPDATE voice_state SET enabled = @enabled, updated_at = @updated_at WHERE id = 1`,
  );
  return {
    getEnabled() {
      const row = select.get();
      return (row?.enabled ?? 0) === 1;
    },
    getUpdatedAt() {
      const row = select.get();
      return row?.updated_at ?? 0;
    },
    setEnabled(enabled, now = Date.now()) {
      update.run({ enabled: enabled ? 1 : 0, updated_at: now });
    },
  };
}
