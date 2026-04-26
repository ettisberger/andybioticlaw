# notes — the principal's notes, via MCP tools

You have access to six notes tools backed by a SQLite-stored notes table.
Notes are markdown bodies with optional title, freeform string tags, and
soft-archive lifecycle. They are NOT loaded into your context
automatically — reach for `list_notes` when the conversation calls for
it.

## When to use these tools

- The principal asks you to "save", "note", "remember as a note", "write
  down", or similar → call `create_note`. Pull the body verbatim from
  what they said.
- The principal asks "what notes do I have", "do I have notes about
  X", "remind me what I noted about Y" → call `list_notes` (with `query`
  if they named a topic). Summarise the matches in your reply.
- The principal asks for the full text of a specific note → call
  `get_note(id)`. The list view returns truncated snippets.
- The principal asks to update or correct a note → `update_note`. Only
  send the fields that change.
- The principal asks to delete or remove a note → `archive_note`. This
  is a soft delete: the note is hidden from the default list but can be
  recovered by `unarchive_note`. You cannot hard-delete a note — that
  is dashboard-only.

## When NOT to use these tools

- Don't auto-save random conversational asides. Save only what the
  principal explicitly asks to save.
- Don't dump the entire notes table at the start of a conversation.
  These tools are on-demand.
- Don't use notes as a substitute for memory. If the principal tells
  you a recurring fact about themselves ("I'm vegetarian", "my partner
  is named Sarah"), that belongs in memory, not notes.

## Tools

### `mcp__notes__create_note`
Arguments: `{ body, title?, tags? }`

Creates a new note. `body` is markdown. `title` is optional — if
omitted, the dashboard derives a title from the first line of the body.
`tags` is an optional array of freeform string labels.

Returns: `{ id, title, body, tags, created_at, updated_at }`.

### `mcp__notes__list_notes`
Arguments: `{ query?, tag?, limit?, includeArchived? }`

Lists notes, newest-first (pinned float to top). With `query` set, runs
a full-text search (FTS5, ranked by relevance). With `tag` set, filters
to notes whose tags array contains that string. `limit` defaults to 20.
`includeArchived` defaults to false.

Returns: `{ notes: [{ id, title, snippet, tags, updated_at, source }], count }`
where `snippet` is the first ~200 chars of the body.

### `mcp__notes__get_note`
Arguments: `{ id }`

Returns the full note, including body in full.

### `mcp__notes__update_note`
Arguments: `{ id, body?, title?, tags? }`

Updates the named fields. Omitted fields are unchanged. Bumps
`updated_at`.

### `mcp__notes__archive_note`
Arguments: `{ id }`

Soft-archives the note. It disappears from the default list but
remains in the DB.

### `mcp__notes__unarchive_note`
Arguments: `{ id }`

Reverses an archive.

## Response presentation

When showing a note list, prefer a compact format:

    📝 #{id} <b>{title}</b>
    {first 80 chars of body, plain}
    🏷 {tags joined with " · "}  ⏰ {relative time}

For a single note (`get_note`), render the body as Telegram-supported
HTML (use the same allowed tags as the rest of your replies). HTML-escape
title + body before placing in the reply.

When confirming a `create_note`, show just `📝 saved as note #{id}` plus
the title — don't echo the whole body back, the principal just wrote it.
