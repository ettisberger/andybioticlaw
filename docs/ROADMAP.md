# andybioticlaw — Roadmap

Living list. Updated whenever a feature is proposed, dropped, or shipped.
Newest ideas go to the bottom of Backlog; items move from Backlog to
"Planned next" when scheduled; items move from "Planned next" to
"Shipped" once they land in main.

Maintenance rule: update this file **in the same commit** that proposes,
drops, or ships the idea. For tiny ideas that come up mid-conversation,
a one-line add to Backlog is enough — don't gate on a full spec.

## Planned next

- **Skill hot-reload** — re-spawn an MCP server without a full Emma
  restart. Faster skill dev loop. ~ half day.

## Backlog — high-impact, small scope (quick wins)

- **Live Sessions via SSE** — replace 2s polling with a single SSE
  stream. One open connection, instant updates, less chatter.
  ~ half day.
- **Mobile-friendly dashboard pass** — breakpoint audit, some
  `md:grid-cols-2 grid-cols-1` swaps. ~ half day.
- **Config-page numeric unit heuristics — broader audit** — fixed in
  `844a9b1` for `conversationHistoryLimit → msgs`; other potentially
  wrong units worth auditing as the config grows.
- **Memory hygiene — re-enable dashboard UI** — DB plumbing is
  already in (migration 0007, `last_used_at` bumped on every
  snapshot). Put the Last-used column + Stale filter + pin button
  back when skill-scoped memories are common or any scope grows
  past `MemoryManager.snapshot()`'s `maxEntries=50` cutoff — that's
  when pruning candidates actually differ from "everything Emma
  has."

## Backlog — medium scope (a weekend each)

- **Photo input** — Telegram `message.photo[]` → Claude CLI
  `--input-format stream-json` with image blocks. Mirror of `voice.ts`
  pipeline. ~ 1 day.
- **Gmail skill via Google OAuth device flow** — same pattern as
  google-calendar. Probably worth factoring out a shared Google-OAuth
  helper first once we have two Google skills.
- **Backup / restore flow** — `andybioticlaw export` → encrypted
  tarball (SQLite + `.env` + skill secrets). `import` on a fresh VPS.
- **Skill testing harness** — dry-run a skill's `install.sh` + MCP
  server against a fake principal.
- **Message-history summarisation** — compress old messages into a
  summary before feeding them to context. Saves tokens on long chats.
- **Smarter model router** — upgrade the heuristic router to an
  LLM-based classifier once we have enough session data to know where
  the cheap heuristic mis-routes.

## Backlog — large scope (weeks)

- **Security tier 2 — systemd sandbox directives** (`PrivateTmp`,
  `ProtectHome`, `ReadWritePaths`, `NoNewPrivileges`, …) in the
  service unit. Filesystem-level hardening.
- **Security tier 3 — bubblewrap / Docker isolation** per session
  with a per-session writable workspace + read-only FS. Real
  "runMode workspace" implementation.
- **Security tier 4 — separate OS user + secrets proxy**. Emma never
  sees `.env`; a tiny proxy service holds secrets and injects them
  at egress.
- **Network egress allowlist** — iptables/nftables kernel-level
  default-deny with specific API endpoints whitelisted. Closes the
  `curl attacker.com` exfil path that outbound-redaction can't.
- **Multi-user / group chat scope** — real
  `telegram.group.runMode: workspace` support with per-chat isolation.
- **Multiple personas per context** — "work-Emma" vs "personal-Emma"
  system prompts picked by chat origin.

## Backlog — lower priority / not yet compelling

- Prometheus `/metrics` endpoint (only matters once we have Grafana).
- Inline Telegram reactions / polls / quizzes.
- Skill marketplace / install-from-URL (only useful with ≥20 skills).
- Gesture / haptic feedback on the web dashboard (no mobile app yet).

## Shipped

- **`andybioticlaw doctor` command** — single read-only health check
  covering config, DB, claude auth, telegram, dashboard, service
  pidfile, skills (with live MCP server probe via JSON-RPC), schedules,
  disk free space, logs, and budget. Tabular ✓/!/✗/— output with
  `--json` (machine-readable) and `--verbose` (extra detail per row).
  Exits non-zero if any row fails. Skill probes spawn each enabled
  MCP server and send `initialize` + `tools/list` over stdio — if the
  server exits before answering, the doctor surfaces the exit code
  plus the last stderr line so config issues like missing OAuth
  secrets are diagnosable at a glance.
- **Notes skill + dashboard page** — markdown-bodied notes with FTS5
  full-text search, freeform tags, soft-archive lifecycle. New `notes`
  MCP skill (6 tools: create / list / get / update / archive /
  unarchive); hard-delete is dashboard-only. Notes do NOT auto-load
  into Emma's context — she reaches for `list_notes` when conversation
  calls for it. Dashboard page renders bodies as markdown, supports
  pin / archive / hard-delete, tag-chip filtering, and a debounced
  search box. Side benefit: extended `buildMcpConfig` with
  `frameworkEnv` so any future skill MCP server gets
  `ANDYBIOTICLAW_DB_PATH` + `PATH` / `HOME` automatically — no manifest
  boilerplate needed.
- **Proactive briefings** — morning + evening DMs from Emma at operator-
  configured times. Wraps the existing `agent-task` scheduler kind.
  Toggled from the Settings menu under "Briefings".
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
- **Model routing (Opus ↔ Haiku)** — opt-in heuristic router (length +
  keyword + `/opus` / `/haiku` slash prefix) at `src/agent/route.ts`.
  Toggled from Settings → Agent → "Cheap-model router".
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
- **Memory hygiene — DB plumbing only** — migration 0007 adds
  `last_used_at` + `pinned` columns. `MemoryManager.snapshot()` bumps
  `last_used_at` for every entry it reads into context. Dashboard UI
  + pin endpoint were reverted the same day: for a single-user setup
  where every DM loads all global/user/chat memories, the Stale
  filter has nothing meaningful to hide. Data collection continues
  silently so the UI can come back cheaply once skill-scoped
  memories or a >50-entry scope makes the distinction meaningful.
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
