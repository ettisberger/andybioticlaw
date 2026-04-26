-- Notes — durable, searchable user notes (separate from `memory`).
--
-- Memory is auto-loaded into every prompt and capped to ~50 entries per
-- scope. Notes are user-content: longer bodies, tags, full-text search,
-- archive lifecycle. They should NOT auto-load — Emma reaches them via
-- the `list_notes` MCP tool when conversation calls for it.
--
-- `user_id` is reserved for a future per-user/per-chat scope rollout
-- (today everything is global / single-principal). Keeping the column
-- nullable now means that change is a code-only migration later.
--
-- `notes_fts` is the project's first FTS5 virtual table; the three
-- triggers (ai/ad/au) keep it in sync with the base table on every
-- insert/delete/update.

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_notes_active_updated
  ON notes (archived, pinned DESC, updated_at DESC);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body, tags,
  content='notes',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body, tags)
  VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body, tags)
  VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO notes_fts (rowid, title, body, tags)
  VALUES (new.id, new.title, new.body, new.tags);
END;
