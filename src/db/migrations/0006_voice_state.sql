-- Phase "voice input" — feature-flag + bookkeeping for Telegram voice messages.
--
-- When a Telegram user sends a voice message, the DM handler transcribes
-- it via the Groq Whisper API and hands the resulting text to Emma's
-- session as if it had been typed. Two things need to persist:
--   1. Whether voice input is enabled (toggleable from the CLI menu
--      without a service restart — that's why this lives in SQLite,
--      not .env).
--   2. When it was last changed (nice for the menu's status line).
--
-- The `GROQ_API_KEY` lives in .env with the other secrets; this table
-- only tracks the operator's on/off choice.
--
-- Single-row table (id=1 enforced by CHECK). Same "state blob" pattern
-- as budget_state.

CREATE TABLE IF NOT EXISTS voice_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO voice_state (id, enabled, updated_at)
VALUES (1, 0, strftime('%s', 'now') * 1000);
