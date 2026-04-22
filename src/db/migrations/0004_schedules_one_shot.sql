-- Phase "reminders" — one-shot schedules.
--
-- Pre-migration, `schedules` only represented recurring cron jobs. To let
-- Emma handle "remind me at 15:30" without a second table, we add a
-- `recurring` flag. One-shot entries still use a pinned cron expression
-- (minute + hour + day + month + any DoW), but after a successful or
-- terminal-failed fire the scheduler deletes the row so it cannot fire
-- again. This matches the pattern used by Claude Code's CronCreate tool
-- (`recurring: false`) and APScheduler's DateTrigger.
--
-- Default is 1 (recurring) so pre-existing rows keep their previous
-- semantics untouched.

ALTER TABLE schedules ADD COLUMN recurring INTEGER NOT NULL DEFAULT 1;
