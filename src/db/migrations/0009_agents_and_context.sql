-- Multi-agent + per-context policy refactor.
--
-- Two additive columns prepare existing tables for the new model:
--
--   1. `sessions.agent_id` — which agent this session ran as. Defaults
--      to 'emma' so existing rows backfill cleanly. The auto-config
--      migration in src/index.ts ensures the default agent's id matches
--      whatever was previously in `agent.name` (slugified). A custom
--      agent name is an edge case operators can fix with one UPDATE.
--
--   2. `schedules.context` — the context (agent + channel + chat) this
--      schedule fires under. Nullable on purpose: existing rows get
--      NULL and the dispatcher falls back to "default agent + principal
--      DM" so today's schedules keep working. New rows always carry a
--      context.
--
-- Strictly additive — no column drops, no rename, no destructive
-- backfill. Downgrade-via-DB-restore stays safe.

ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'emma';
ALTER TABLE schedules ADD COLUMN context TEXT;

-- Index sessions.agent_id so per-agent dashboard filters stay fast as
-- the table grows past N agents (none today; matters when the operator
-- adds a second).
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
