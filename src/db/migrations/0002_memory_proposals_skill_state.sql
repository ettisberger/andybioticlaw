-- Phase 3 additions: memory-proposal queue + skill enable/disable state.

CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  proposed_key TEXT,
  ttl_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed | expired
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  committed_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  telegram_button_message_id INTEGER,
  telegram_chat_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_proposals_session ON memory_proposals(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status);

-- Track enable/disable state for installed skills. Overrides manifest.enabled
-- when present. We do not overwrite manifest.yaml on enable/disable (to avoid
-- comment loss); DB state is authoritative once the skill is installed.
CREATE TABLE IF NOT EXISTS skill_state (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  installed_at INTEGER NOT NULL,
  last_install_output TEXT,
  last_enabled_at INTEGER,
  last_disabled_at INTEGER
);
