# _template skill

This file is injected verbatim into the agent's system prompt whenever the
skill is active in the current session scope. Keep it short, concrete, and
task-oriented — you're writing prompt, not documentation.

## What this skill is for

Describe, in a sentence or two, what capability this skill grants Emma and
when it is relevant. Example: "Grants read-only access to the user's Google
Calendar so Emma can answer scheduling questions without asking for context."

## How to use it

List the tools / MCP server endpoints this skill provides and the typical
flow. Example:

- `calendar.list_events(from, to)` — get events in a date range.
- `calendar.search(query)` — search event titles.

If the skill has a preferred reasoning pattern (e.g. "always resolve
timezone before answering scheduling questions"), say it here.

## What not to do

Call out any gotchas — e.g. don't expose raw attendee emails, don't guess
when a search returns zero results.
