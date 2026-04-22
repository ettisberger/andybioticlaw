-- Phase "budget overrides" — manual daily-budget reset.
--
-- The daily token budget is a SOFT guard against runaway spending — it's
-- our own definition, not an Anthropic-enforced limit. The principal
-- (directly or via Emma) occasionally wants to clear the counter
-- mid-window without waiting for the natural reset at `dailyResetTime`.
--
-- We can't just zero out session token counts (they're authoritative
-- billing records). Instead this table holds an optional "reset anchor"
-- — a timestamp that, when newer than the natural window start, becomes
-- the effective window start. The BudgetTracker consults it on every
-- `status()` call. Once the next natural reset rolls past the anchor,
-- the anchor is implicitly ignored (it's older than the new window).
--
-- Single-row table (id=1 enforced by CHECK). Keeps the "state blob"
-- pattern out of `memory` which is scoped/TTL'd for agent use.

CREATE TABLE IF NOT EXISTS budget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- NULL means "no manual reset active — use the natural daily window".
  daily_reset_anchor_ms INTEGER
);

INSERT OR IGNORE INTO budget_state (id, daily_reset_anchor_ms) VALUES (1, NULL);
