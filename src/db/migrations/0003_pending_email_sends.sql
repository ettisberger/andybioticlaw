-- Phase "himalaya hardening" — HITL gate for outbound email.
--
-- Emma is instructed to call `himalaya-propose-send` (which writes a
-- pending row here) instead of the raw `himalaya message send`. She then
-- asks the principal to confirm in Telegram. When the principal's next
-- user message arrives, Emma processes it in a NEW session; only then
-- can she call `himalaya-commit-send`, which enforces at the DB level
-- that the commit session id differs from the propose session id. This
-- makes it impossible for a single-session injection to both draft AND
-- send an email — a user message must arrive between the two.

CREATE TABLE IF NOT EXISTS pending_email_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Identity of the session that proposed the send.
  propose_session_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,

  -- The draft.
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  cc_addr TEXT,
  bcc_addr TEXT,

  -- Lifecycle.
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | cancelled | expired
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  -- Identity of the session that committed the send (MUST differ from propose_session_id).
  commit_session_id TEXT,
  -- Set on failure: himalaya exit code + first line of stderr.
  commit_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_email_sends_status
  ON pending_email_sends(status);
CREATE INDEX IF NOT EXISTS idx_pending_email_sends_propose_session
  ON pending_email_sends(propose_session_id);
