-- Memory hygiene — `last_used_at` + `pinned` columns on `memory`.
--
-- Today we can't tell which memories are actually load-bearing for
-- Emma's context vs. which are cruft nobody's referenced in months.
-- Two additions fix that:
--
--   1. `last_used_at` — bumped every time `MemoryManager.snapshot()`
--      pulls the entry into Emma's system prompt. Nullable so old
--      rows show "never referenced" until their first post-migration
--      read.
--
--   2. `pinned` — operator-set flag that protects an entry from the
--      dashboard "Stale only" filter, even if it hasn't been touched
--      in a long time. Defaults to 0.

ALTER TABLE memory ADD COLUMN last_used_at INTEGER;
ALTER TABLE memory ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
