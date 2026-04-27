# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses semantic-ish versioning during pre-1.0 development.

## [0.22.4](https://github.com/ettisberger/andybioticlaw/compare/v0.22.3...v0.22.4) (2026-04-27)


### Features

* drop legacy single-agent paths; agents+bindings required ([f419758](https://github.com/ettisberger/andybioticlaw/commit/f419758077b525016782f2f45ea35f99deeafe5a))

## [0.22.3](https://github.com/ettisberger/andybioticlaw/compare/v0.22.2...v0.22.3) (2026-04-27)


### Features

* **agent:** per-session .claude/settings.json driven by policy + skill exec_allow ([f749ad9](https://github.com/ettisberger/andybioticlaw/commit/f749ad96d9eeba371a6656343dce018109013047))
* **cli/doctor:** Agents + Policies health rows ([c2febe6](https://github.com/ettisberger/andybioticlaw/commit/c2febe6aee81a4c3ffd78540a7096d6703f48380))
* **cli/settings:** Advanced section with Agents + Policies views ([add4326](https://github.com/ettisberger/andybioticlaw/commit/add4326cdc3d2279a0c1d8e76ccf89cf8c3ffc59))
* **cli:** schedule shape-flags + policy/agent subcommands ([d70491e](https://github.com/ettisberger/andybioticlaw/commit/d70491e162e208358ffbaf0498fcda0c28333751))
* **dashboard:** /agents + /policies read-only pages ([3d1b001](https://github.com/ettisberger/andybioticlaw/commit/3d1b0019ebec88c28c6c6fa7627bc66e986d38e6))
* **dashboard:** single + bulk session delete with orphan cleanup ([bac24f9](https://github.com/ettisberger/andybioticlaw/commit/bac24f94af8217ae34d7488d3273073d8c6e77f2))
* drop legacy single-agent paths in favor of policies ([700136b](https://github.com/ettisberger/andybioticlaw/commit/700136b32842885eac9ccfb8eeff65eebe1f74a9))

## [0.22.2](https://github.com/ettisberger/andybioticlaw/compare/v0.22.1...v0.22.2) (2026-04-27)


### Bug Fixes

* **release:** drop SIGPIPE-prone tar|grep preflight ([9315260](https://github.com/ettisberger/andybioticlaw/commit/9315260e2851b465780cabc9c59149165643d507))

## [0.22.1](https://github.com/ettisberger/andybioticlaw/compare/v0.22.0...v0.22.1) (2026-04-27)


### Bug Fixes

* **release:** build root + web in tarball workflow ([0662294](https://github.com/ettisberger/andybioticlaw/commit/0662294bb8536aed773a6a832030bfe3ad46b6bb))

## [0.22.0](https://github.com/ettisberger/andybioticlaw/compare/v0.21.0...v0.22.0) (2026-04-27)


### Features

* let Emma create agent-task schedules (daily-digest pattern) ([b9e3c2a](https://github.com/ettisberger/andybioticlaw/commit/b9e3c2a4309939ffeef1298ca021cf4ee74adbaf))

## [0.21.0](https://github.com/ettisberger/andybioticlaw/compare/v0.20.0...v0.21.0) (2026-04-26)


### Features

* **cli:** add `andybioticlaw doctor` health check ([87d442a](https://github.com/ettisberger/andybioticlaw/commit/87d442a697677bfdc73828a044234e838c296585))

## [0.20.0](https://github.com/ettisberger/andybioticlaw/compare/v0.19.0...v0.20.0) (2026-04-26)


### Features

* notes skill with FTS5 + dashboard page ([c8be04a](https://github.com/ettisberger/andybioticlaw/commit/c8be04a312b82eaefe84cd57dfa1c4621c50c062))

## [0.19.0](https://github.com/ettisberger/andybioticlaw/compare/v0.18.1...v0.19.0) (2026-04-25)


### Features

* **skill/google-calendar:** add list_calendars tool ([b81d6bb](https://github.com/ettisberger/andybioticlaw/commit/b81d6bb3fbf4d065d3fc975e416b8f312b0a86fc))

## [0.18.1](https://github.com/ettisberger/andybioticlaw/compare/v0.18.0...v0.18.1) (2026-04-24)


### Reverts

* **dashboard:** drop memory hygiene UI, keep DB plumbing ([0df6557](https://github.com/ettisberger/andybioticlaw/commit/0df655747d456f55b5372afefe020d9b9488ebc5))

## [0.18.0](https://github.com/ettisberger/andybioticlaw/compare/v0.17.1...v0.18.0) (2026-04-24)


### Features

* proactive briefings + model routing + memory hygiene + roadmap ([818bb65](https://github.com/ettisberger/andybioticlaw/commit/818bb656300dad0e1ec09e08937a7e302d9f9759))
* proactive briefings + model routing + memory hygiene + roadmap ([2d9a911](https://github.com/ettisberger/andybioticlaw/commit/2d9a911701f1f48b15dd62a02e5a73396689f1d7))

## [0.17.1](https://github.com/ettisberger/andybioticlaw/compare/v0.17.0...v0.17.1) (2026-04-24)


### Bug Fixes

* **dashboard:** correct unit suffix on telegram.conversationHistoryLimit ([8364b4d](https://github.com/ettisberger/andybioticlaw/commit/8364b4d77fd77cb17a20ae2d0d6795722b852367))

## [0.17.0](https://github.com/ettisberger/andybioticlaw/compare/v0.16.0...v0.17.0) (2026-04-24)


### Features

* **dashboard:** compact Subscription-window card with info popover ([7d65195](https://github.com/ettisberger/andybioticlaw/commit/7d651954046e929a2ca40e40b2ac29d915a4a665))

## [0.16.0](https://github.com/ettisberger/andybioticlaw/compare/v0.15.0...v0.16.0) (2026-04-24)


### Features

* **security:** host-mode exfil defense — env scrub + outbound redaction + stronger guardrails ([d2e21b9](https://github.com/ettisberger/andybioticlaw/commit/d2e21b96216a58b247874dbfaff36641edeba58c))

## [0.15.0](https://github.com/ettisberger/andybioticlaw/compare/v0.14.0...v0.15.0) (2026-04-24)


### Features

* **dashboard:** redesigned Config page with Cards view + JSON toggle ([a0fdf3c](https://github.com/ettisberger/andybioticlaw/commit/a0fdf3cb6789b769a3bd05a80001cdf16570c1bd))

## [0.14.0](https://github.com/ettisberger/andybioticlaw/compare/v0.13.0...v0.14.0) (2026-04-24)


### Features

* **cli:** component-based Settings menu with id-routing + tests ([39c85e0](https://github.com/ettisberger/andybioticlaw/commit/39c85e06747eb02516dc9c830882ce46ef14040f))

## [0.13.0](https://github.com/ettisberger/andybioticlaw/compare/v0.12.0...v0.13.0) (2026-04-24)


### Features

* **cli:** unify Settings menu with in-place ☑/☐ toggles ([2c3ac07](https://github.com/ettisberger/andybioticlaw/commit/2c3ac07a861daddfa1719c9654cee7661a83774a))

## [0.12.0](https://github.com/ettisberger/andybioticlaw/compare/v0.11.0...v0.12.0) (2026-04-24)


### Features

* **telegram:** voice input via groq whisper (menu-togglable) ([2f3c91e](https://github.com/ettisberger/andybioticlaw/commit/2f3c91ee53dc76f995ed5f21036667c45f06678e))

## [0.11.0](https://github.com/ettisberger/andybioticlaw/compare/v0.10.2...v0.11.0) (2026-04-24)


### Features

* **telegram:** /reset_budget command + slash-menu registration ([83d7c4e](https://github.com/ettisberger/andybioticlaw/commit/83d7c4e49d34409e5e48e22b5eed696dc656a54c))

## [0.10.2](https://github.com/ettisberger/andybioticlaw/compare/v0.10.1...v0.10.2) (2026-04-24)


### Bug Fixes

* **skills:** scope bracketed-paste disable to the whole setup flow ([24f57f6](https://github.com/ettisberger/andybioticlaw/commit/24f57f6c201d1a803369bb370964a0a9d775e1ce))

## [0.10.1](https://github.com/ettisberger/andybioticlaw/compare/v0.10.0...v0.10.1) (2026-04-24)


### Bug Fixes

* **wizard:** strip ANSI escape sequences so pasted secrets land clean ([c50b907](https://github.com/ettisberger/andybioticlaw/commit/c50b907c29a330841c9b9c2c30b6472d974c4094))

## [0.10.0](https://github.com/ettisberger/andybioticlaw/compare/v0.9.0...v0.10.0) (2026-04-24)


### Features

* **dashboard:** default to light theme, ignore system preference ([549527f](https://github.com/ettisberger/andybioticlaw/commit/549527feb46892c05c0b2b7c65858142baf3b3d2))
* **skills:** add hue (philips) skill via the Remote API ([e42077c](https://github.com/ettisberger/andybioticlaw/commit/e42077ce6825c2bdf686540ba4815f99ecb94c39))

## [0.9.0](https://github.com/ettisberger/andybioticlaw/compare/v0.8.0...v0.9.0) (2026-04-24)


### Features

* **dashboard:** iterate on liquid-glass per ui-ux-pro-max review ([97ab2a6](https://github.com/ettisberger/andybioticlaw/commit/97ab2a685756046e7b852be067942b895590a149))
* **dashboard:** liquid-glass redesign with dark mode + right-now hero ([9c2adb4](https://github.com/ettisberger/andybioticlaw/commit/9c2adb4897c837fc0f44fe7bda502758e79f8d35))

## [0.8.0](https://github.com/ettisberger/andybioticlaw/compare/v0.7.0...v0.8.0) (2026-04-24)


### Features

* **dashboard:** live session view + memory search/revoke ([531e4c9](https://github.com/ettisberger/andybioticlaw/commit/531e4c9cd8880f6052a2fb4689c378963af2c839))

## [0.7.0](https://github.com/ettisberger/andybioticlaw/compare/v0.6.0...v0.7.0) (2026-04-24)


### Features

* **telegram:** enable HTML parse_mode for bold/italic/code/links in replies ([5073343](https://github.com/ettisberger/andybioticlaw/commit/50733439e37d68e220269b8662cb1e08edfdea57))

## [0.6.0](https://github.com/ettisberger/andybioticlaw/compare/v0.5.5...v0.6.0) (2026-04-24)


### Features

* **agent:** teach Emma to use emojis and compact layout in Telegram ([e5282d6](https://github.com/ettisberger/andybioticlaw/commit/e5282d67ad75ec03c73c28f551a6eae77dfc9ec4))

## [0.5.5](https://github.com/ettisberger/andybioticlaw/compare/v0.5.4...v0.5.5) (2026-04-24)


### Bug Fixes

* **skills:** resolve relative MCP server paths against the skill dir ([c8172d6](https://github.com/ettisberger/andybioticlaw/commit/c8172d653ad8f45fec702e679c65989697a6c4f1))

## [0.5.4](https://github.com/ettisberger/andybioticlaw/compare/v0.5.3...v0.5.4) (2026-04-24)


### Bug Fixes

* **installer:** stream install.sh output live for interactive flows ([b04bc6b](https://github.com/ettisberger/andybioticlaw/commit/b04bc6b54185e1c5c6fd6496f2332ba440a56ca4))

## [0.5.3](https://github.com/ettisberger/andybioticlaw/compare/v0.5.2...v0.5.3) (2026-04-24)


### Bug Fixes

* **google-calendar:** tolerate pretty-printed JSON in install.sh ([a60c449](https://github.com/ettisberger/andybioticlaw/commit/a60c449e0841d73cf06aa930c324a7d73c0cdd31))

## [0.5.2](https://github.com/ettisberger/andybioticlaw/compare/v0.5.1...v0.5.2) (2026-04-24)


### Bug Fixes

* **google-calendar:** tolerate no-match grep in install.sh error-check ([8b08ba1](https://github.com/ettisberger/andybioticlaw/commit/8b08ba16413f1d7ee9ae80064c6448e351b53184))

## [0.5.1](https://github.com/ettisberger/andybioticlaw/compare/v0.5.0...v0.5.1) (2026-04-24)


### Bug Fixes

* **wizard:** unified section style, colored prompts, re-run keeps current as default ([f1255aa](https://github.com/ettisberger/andybioticlaw/commit/f1255aacd692e933cd5cf66433697eb3de3a64e2))

## [0.5.0](https://github.com/ettisberger/andybioticlaw/compare/v0.4.0...v0.5.0) (2026-04-24)


### Features

* skill management — menu entry, dashboard details, google-calendar ([0b2f499](https://github.com/ettisberger/andybioticlaw/commit/0b2f4996128d29f9a3ceda90fd73936882071000))

## [0.4.0](https://github.com/ettisberger/andybioticlaw/compare/v0.3.2...v0.4.0) (2026-04-24)


### Features

* cost + usage insights dashboard ([f78dcb4](https://github.com/ettisberger/andybioticlaw/commit/f78dcb4638e9fab56ffe92a5193eff270d11fab9))

## [0.3.2](https://github.com/ettisberger/andybioticlaw/compare/v0.3.1...v0.3.2) (2026-04-23)


### Bug Fixes

* **credentials:** accept CLAUDE_CODE_OAUTH_TOKEN auth path ([7de6a24](https://github.com/ettisberger/andybioticlaw/commit/7de6a24a3dd3ce1fda49ba8d95320a376ad706fc))

## [0.3.1](https://github.com/ettisberger/andybioticlaw/compare/v0.3.0...v0.3.1) (2026-04-23)


### Bug Fixes

* **wizard:** arrow-key pickers for timezone + claude auth steps ([4fc5607](https://github.com/ettisberger/andybioticlaw/commit/4fc5607dc32635c3ccba73061360ebac1dae2bdb))

## [0.3.0](https://github.com/ettisberger/andybioticlaw/compare/v0.2.0...v0.3.0) (2026-04-23)


### Features

* accept CLAUDE_CODE_OAUTH_TOKEN auth alongside claude login ([9b91955](https://github.com/ettisberger/andybioticlaw/commit/9b91955231ad4e1c5af8719719cdbec795d3ec64))

## [0.2.0](https://github.com/ettisberger/andybioticlaw/compare/v0.1.0...v0.2.0) (2026-04-23)


### Features

* agent hero card + release-aware update ([76ad0a0](https://github.com/ettisberger/andybioticlaw/commit/76ad0a069681349c457ac1e4e11d6f91cf505536))

## [Unreleased]

### Added — Post-audit hardening (2026-04-22)

After the end-of-spec code review, three must-fix items were addressed:

- **Session-workspace sweep** (`src/observability/workspace-cleanup.ts`).
  Per-session `data/workspaces/dm/<session-id>/` dirs were never
  cleaned up. Added a nightly sweeper folded into the existing memory
  TTL cron — removes any workspace dir older than 24h whose session is
  in a terminal state or whose session row has been pruned. Leaves
  running/queued session dirs alone. 5 new unit tests.
- **SQL key allowlist in dynamic `update()` methods**
  (`src/db/repositories/{sessions,memory,schedules}.ts`). Defense-in-depth
  against a future untyped caller. Keys interpolated into SET clauses
  are filtered against explicit per-repo allowlists at runtime;
  unknown keys are silently ignored. 3 regression tests that inject
  keys like `"tokens_input = 0; DROP TABLE sessions; --"` and assert
  they don't reach SQL.
- **`docs/SECURITY.md`** — explicit trust-boundary document. Covers
  subscription-only enforcement layers, secret scoping, SQL defense,
  file permissions, systemd sandboxing, and the
  "bash-schedules-are-shell-by-design" posture. README now links to
  it and includes a security-posture section at the top.

### Changed — System-prompt cache optimization (2026-04-22)

Two tweaks to the system-prompt assembly that drop input-token cost
on quick-succession chats without changing Emma's behavior meaningfully:

- **Section order is now cache-stable → cache-volatile.** Base prompt,
  active memory, installed skills, memory-tool block, and the static
  runtime meta live in the prefix; conversation history and current
  time live in the suffix. The first four layers no longer change
  unless the operator changes them, which lets Anthropic's prompt
  cache re-use everything before `## Conversation history` across
  turns in the same chat.
- **Current time is rounded to 15-minute buckets** (configurable via
  `timeBucketMs` on `ContextAssemblyInput`, default `900_000 ms`). A
  burst of DMs inside the same 15-min window produces byte-identical
  prompt prefixes → full cache hit. The time footer explicitly
  documents the bucketing so Emma can run `date -u` for exact time
  when she needs it.
- 5 new regression tests in `tests/unit/context.test.ts` lock in the
  ordering, verify the stable meta no longer contains a timestamp,
  confirm 15-min bucketing, and prove two turns in the same bucket
  produce byte-identical prefixes up to the history block.

### Added — Phase 6 (Production readiness)

- **`scripts/install.sh` complete + idempotent.** Pre-flight (root,
  systemd, node ≥ 20, sqlite3, logrotate, corepack/pnpm), creates
  `andybioticlaw` system user with home dir, sets `/opt/andybioticlaw`
  ownership (750 on the tree, 700 on `data/`), runs `pnpm install
  --prod --frozen-lockfile` as the service user so native deps
  (`better-sqlite3`, `argon2`) compile for the target arch, installs
  + enables three systemd units (main service + backup service +
  backup timer), installs and validates the logrotate config. Prints
  a clear next-steps block covering `claude login`, config.yaml,
  `.env`, and `systemctl start`.
- **Backup script with rotation** (`scripts/backup.sh`). Online
  SQLite `.backup` (WAL-safe while the writer is live), integrity
  check on the new artifact, `ANDYBIOTICLAW_BACKUP_RETENTION_DAYS`
  (default 7)–driven prune via `find -mtime +N -delete`.
- **systemd timer** for daily backups at ~03:15 local with a 15-min
  jitter + `Persistent=true` so we recover a missed run after downtime
  (`systemd/andybioticlaw-backup.{service,timer}`).
- **logrotate config** (`systemd/andybioticlaw.logrotate`). Daily
  rotation, 14-day retention, compressed, `create 0600`. Zero
  service-side coordination needed — the pino logger opens the file
  path (not a long-lived fd) on each append, so the next write after
  rotation lands in the freshly-created file.
- **Integration tests** (`tests/integration/`):
  - `boot-and-shutdown.test.ts` — spawns `node dist/index.js` in a
    scratch data+config dir, polls `/api/overview` until it responds,
    SIGTERMs, asserts exit code 0 and pidfile removal. Real black-box
    coverage of the full boot → listen → clean-shutdown path.
  - `migrations.test.ts` — fresh DB gets every migration (both 0001
    + 0002); re-opening the same DB is idempotent (no duplicate
    schema_version rows).
  - `orphan-recovery.test.ts` — preloads sessions in `running` +
    `queued`, calls `markRunningAsOrphaned()`, asserts the flip plus
    distinct chat-id reporting that feeds the startup aggregated DM.
- **Hetzner deployment guide** (`docs/DEPLOYMENT.md`). Step-by-step
  for a bare Ubuntu 24.04 VPS: harden base image, install prereqs,
  build + rsync from dev machine, run `install.sh`, `claude login`
  as the service user, populate config + `.env`, start the service,
  verify backup timer. Plus optional nginx + certbot reverse proxy
  with app-layer basic auth for exposing the dashboard over HTTPS.

### Added — Phase 5 (Dashboard)

- Full HTTP API + WebSocket log stream on `localhost:18790` (default) via
  Fastify 5. Optional HTTP Basic Auth (argon2) when
  `dashboard.basicAuth.enabled: true`.
- New deps: `fastify`, `@fastify/static`, `@fastify/websocket`,
  `@fastify/basic-auth`, `argon2`.
- pnpm workspace: root (`andybioticlaw`) + `web/` (`@andybioticlaw/web`).
- **API routes** (all namespaced under `/api/`):
  - `GET /api/overview` — summary card data.
  - `GET /api/sessions[?status=...&limit=N]`; `GET /api/sessions/:id`;
    `POST /api/sessions/:id/retry` — **Phase 5 done-criterion Retry
    button.** Dispatches a new session with the prior input via the
    same per-chat queue as Telegram.
  - `GET /api/schedules`, `GET /api/schedules/:id`,
    `POST /api/schedules/:id/enable|disable` (mutations refresh the engine).
  - `GET /api/memory[?scope=&limit=]`, `GET /api/memory/active`,
    `DELETE /api/memory/:id`.
  - `GET /api/skills`.
  - `GET /api/config` — full config with `dashboard.basicAuth.passwordHash`
    redacted to `[REDACTED]`.
  - `GET /api/audit[?kind=&limit=]`.
  - `GET /api/logs/stream` (WebSocket) — JSON-lines appended to
    `data/logs/andybioticlaw.log` forwarded live.
- **Dashboard composition** (`src/dashboard/server.ts`): conditional basic-auth,
  websocket plugin, all routes, static-serve for `web/dist/` with SPA
  fallback (non-`/api/` 404 → `index.html`).
- **Shared dispatch** (`src/agent/dispatch.ts`): extracted from the
  Telegram DM handler so the dashboard retry endpoint can submit prompts
  without a grammy Context. Telegram handler now delegates to it.
- **Frontend** (`web/`): React 19 + Vite 6 + Tailwind v4 (via
  `@tailwindcss/vite`), react-router-dom v7, minimal in-house UI kit
  (Card/Button/Badge/Table — no shadcn CLI needed). 8 routes total:
  Overview / Sessions (+ detail) / Schedules / Memory / Skills / Logs /
  Config / Audit. Live log page uses browser-native WebSocket, parses
  pino JSON lines, colors by level, auto-follows unless the user scrolls
  up.
- **Live verified**: all 8 endpoints → 200, SPA deep-link → `index.html`,
  `/api/config` → passwordHash `""` (empty default) served as-is, 3
  consecutive `received SIGHUP` log lines forwarded live via WebSocket.
- **Dev workflow**: `pnpm --filter @andybioticlaw/web dev` runs Vite on
  :5173 with a `/api` proxy to :18790. `pnpm --filter @andybioticlaw/web
  build` produces `web/dist/` which the backend serves in prod.

### Deferred (Phase 5 → Phase 6)

- Create-a-schedule UI (CLI-only).
- Add-a-memory-entry UI (CLI or ask Emma).
- Session cancel from the dashboard (Telegram `/cancel` still works).
- Frontend tests (backend endpoints are the contract).

### Added — Phase 4 (Scheduler)

- `node-cron` (already a Phase 3 dep) drives four schedule kinds from the
  `schedules` table.
- **`bash` kind** (`src/scheduler/handlers/bash.ts`): runs a shell command,
  captures stdout/stderr. If stdout is a JSON `TriggerEnvelope`
  (`{"trigger": true, "prompt": "..."}`), fires a chained agent session
  with that prompt — tokens billed against this schedule's budget. Plain
  stdout is logged and does not consume tokens.
- **`http-check` kind** (`src/scheduler/handlers/http-check.ts`): issues an
  HTTP request, validates status against `expectedStatus`, and chains into
  an agent session on a trigger envelope in the body.
- **`agent-task` kind** (`src/scheduler/handlers/agent-task.ts`): fires a
  Claude session with the configured prompt. Submitted through the same
  per-chat queue as DMs so it serializes behind any active user
  conversation.
- **`reminder` kind** (`src/scheduler/handlers/reminder.ts`): sends a plain
  Telegram message. Free (no Claude roundtrip).
- **Scheduler engine** (`src/scheduler/engine.ts`): dynamic `node-cron`
  task registry — `refresh()` diffs DB schedules against live cron tasks
  and adds/updates/removes as needed. Handles per-firing:
  - Per-schedule budget reset at service-timezone midnight.
  - Per-schedule token budget gate (skip if `budget_used_today >= budget_tokens_per_day`).
  - Global daily budget gate (skip if exhausted) for kinds that spend.
  - Loop protection: auto-disable on 3 consecutive fails OR `>5` runs in 5
    minutes. `schedule_auto_disabled` audit row + principal-DM alert.
  - Budget-exhaustion alert: principal-DM when a run newly busts the
    per-schedule cap, `schedule_budget_exhausted` audit.
  - `consecutive_fails` counter reset on first success.
- **Zod payload schemas** (`src/scheduler/payloads.ts`) — one per kind,
  with `parsePayload(kind, json)` guarding every DB read.
- **Scheduler Telegram sink** (`src/scheduler/telegram-output.ts`): unlike
  the interactive DM sink, this collects all deltas and sends one or more
  complete messages at the end prefixed with `📅 <schedule-name>` so the
  principal can tell schedule output from interactive replies. Handles
  chunking for >3900-char responses.
- **CLI commands** — full `schedule list`, `schedule show <id>`,
  `schedule add --name --cron --kind --payload [--budget] [--disabled]`,
  `schedule enable <id>`, `schedule disable <id>`, `schedule remove <id>`.
  Each mutating command sends SIGHUP to the daemon; a dedicated SIGHUP
  handler in `src/index.ts` calls `scheduler.refresh()` so DB changes
  take effect without restart. Runs the config reloader as before, but
  the scheduler refresh is now decoupled from config hot-reload since
  schedule changes don't touch config.
- **Live E2E verified**: service boots with 0 schedules, CLI adds a
  reminder with cron `* * * * *`, SIGHUP triggers refresh, cron fires at
  the next minute boundary, Telegram message delivered, `schedule_runs`
  row written with `status=success`.
- **Tests** — 14 payload-validation cases + 4 engine cases (budget
  pre-consumption, counter tracking, recent-run window counting, audit
  kind reachability). Full suite: 78 unit tests + 3 skipped E2E.

### Deferred (Phase 4 → later)

- `schedule run <id>` is documented as a dev convenience only; true
  out-of-band immediate firing from the CLI requires an RPC path to the
  running daemon. Workaround: set `cron_expr` to `* * * * *` for one
  minute, then restore.
- No YAML-based declarative schedule config — schedules are defined via
  CLI only (or raw SQL). A `config/schedules.yaml` loader could be
  added later without changing the engine.
- No cron-expression editing via CLI — to change a cron, `remove` + `add`.

### Added — Phase 3 (Memory + Skill Infrastructure)

- `@modelcontextprotocol/sdk` (^1.29.0) and `node-cron` (^4.2.1) — justified:
  the MCP SDK is the canonical way to expose tools to the Claude CLI via
  stdio, and we use one server of our own (`memory-proposal`) plus any a
  skill declares. `node-cron` drives the nightly `memory.ttlCleanupCron`.
- **Migration 0002** (`memory_proposals`, `skill_state` tables).
- **Memory repo full CRUD** (`src/db/repositories/memory.ts`) — create /
  update / remove / get / list / `listActive(scopes, now)` (with TTL filter)
  / `deleteExpired` / proposal CRUD (create / list pending / accept /
  dismiss / expire / button tracking).
- **Memory manager** (`src/memory/manager.ts`) — scope grammar (`global`,
  `user:<id>`, `chat:<id>`, `skill:<name>`, plus arbitrary `<prefix>:<id>`),
  `resolveActiveScopes()`, `snapshot()`, `addManual()`, `runTtlCleanup()`,
  `validateScope()`. Always includes `global` by default.
- **Memory TTL cron** (`src/memory/ttl.ts`) — runs on `memory.ttlCleanupCron`
  in `service.timezone`, deletes expired entries, marks pending proposals
  older than 7 days as `expired`.
- **Memory-proposal MCP server** (`src/mcp/memory-proposal-server.ts`) —
  stdio server exposing `memory_propose(scope, value, key?, ttl_seconds?)`.
  Writes proposals straight into SQLite (WAL-safe multi-process access).
  Env contract: `ANDYBIOTICLAW_DB_PATH`, `_SESSION_ID`, `_CHAT_ID`.
- **Post-session proposal dispatch** (`src/memory/proposals.ts`) — after a
  clean session, the streaming sink's `onEnd` hook queries pending proposals
  and either auto-accepts them (when `memory.autoAccept: true`) or sends
  Telegram inline buttons `[✅ Add] [❌ Dismiss]`.
- **Telegram memory callbacks** (`src/telegram/handlers/memory-callbacks.ts`)
  — button handlers commit to memory and audit-log the decision, edit the
  prompt message to confirm.
- **Telegram memory commands** (`src/telegram/handlers/memory-commands.ts`)
  — `/remember <text>` (defaults to `user:<principal>`, supports `@global`,
  `@chat`, `@user`, `@<custom>` prefixes), `/memory` (shows active snapshot),
  `/forget <id>`.
- **Skill manifest schema** (`src/skills/manifest.ts`) — Zod-validated:
  kebab-case name matching folder; semver version; UPPER_SNAKE secret names;
  non-empty scope from `[dm, group]`; kebab-case MCP server names. Enforces
  the folder-name-equals-manifest-name invariant.
- **Skill loader** (`src/skills/loader.ts`) — actual parsing now. Registers
  each valid skill in the registry; failures are recorded but non-fatal so
  one broken skill doesn't take the service down.
- **Skill registry DB-backed** (`src/skills/registry.ts`) — `skill_state`
  row seeded on first register. `setEnabled` persists across restarts and
  overrides `manifest.enabled`. `requiredSecretsTable()` feeds the secrets
  scoping manager. `activeFor(sessionScope)` filters by enabled + scope.
- **Skill install/uninstall lifecycle** (`src/skills/installer.ts`) — runs
  `install.sh` / `uninstall.sh` from the skill's dir, captures output to
  `skill_state.last_install_output`, audits with `skill_install` /
  `skill_uninstall` kinds. Idempotent by contract.
- **MCP config generation** (`src/skills/mcp.ts`) — `buildMcpConfig()`
  merges our memory-proposal server with each active skill's mcp_servers,
  interpolates `${SECRET_NAME}` env templates via the scoped secrets
  resolver, warns on collisions or unresolved/undeclared secrets.
- **Session integration** — `executeSession` now:
  - Builds an active-memory snapshot from manager + resolves
    active skills from the registry for the session scope.
  - Reads each active skill's SKILL.md fresh each turn (so edits take
    effect without restart).
  - Generates `<workspace>/<session-id>/.mcp.json` and passes it via
    `--mcp-config`.
  - Injects scoped skill secrets into the Claude subprocess env (via
    `runner.buildClaudeEnv` + `extraEnv`).
  - `system/prompt` gets a `## Memory tool` block instructing the agent
    to use `mcp__andybioticlaw-memory__memory_propose`.
- **CLI** — full `memory list/add/remove/show` and `skill list/show/install/
  uninstall/enable/disable` subcommands.
- **Tests** — 30+ new unit tests across manager, loader, MCP config
  generation, skill secret scoping (Phase 3 done-criterion: Skill A reading
  Skill B's secret throws + audit entry). Plus a new E2E test that has the
  agent call `memory_propose` via MCP and verifies the proposal landed in
  the DB.

### Deferred (Phase 3 → later)

- Memory entry editing via CLI (add/remove only; to change, remove + re-add).
- Per-skill install-script sandboxing (currently runs under the service user
  with full shell access; fine for a personal agent, revisit for group v2).
- Proposal dedupe / proposal ttl reaping via cron (only naive age-out today).

### Added — Phase 2.1 (Subscription-auth hardening)

Prompted by a manual check: if `ANTHROPIC_API_KEY` were present in the service
environment, the `claude` CLI would silently switch from subscription auth to
pay-as-you-go API-key billing with no user-visible signal — and my Phase 2
credentials check (`loggedIn === true`) would have green-lit that state. Three
layers added to close the gap:

- **Stricter startup credentials check** (`src/agent/credentials.ts`): requires
  `apiKeySource === "none"` (or missing) AND `subscriptionType` to be truthy.
  Audit row `credentials_missing` now includes the leaked env vars and an
  explicit hint. Emits a separate `api_billing_env_warning` audit row on a
  successful check if billing env vars are present anyway.
- **Runner env filter** (`buildClaudeEnv()` in `src/agent/runner.ts`): strips
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_API_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`
  from every subprocess env.
- **Runtime init-event guard**: on every session, the runner inspects the
  `system/init` event's `apiKeySource` field. Anything other than `"none"` →
  SIGKILL the subprocess, fail the session with a loud error, write an
  `api_key_billing_blocked` audit row. Overridable via `onApiKeyBilling`
  callback for tests.
- **Verified live**: E2E test (`CLAUDE_E2E=1`) sets a bogus `ANTHROPIC_API_KEY`
  in the test process and proves the spawned `claude` reports
  `apiKeySource: "none"` and completes against the subscription.

### Added — Phase 2 (Telegram + Agent Runner + Streaming + Queue + Graceful Failure + Conversation History)

- `grammy` dependency (Telegram bot framework, `^1.42.0`). Justification: matches
  spec's stated stack; no good alternative that combines long-polling + typed
  handlers + stable API at v1+.
- **Agent runner** (`src/agent/runner.ts`) — spawns `claude -p --output-format
  stream-json --verbose --include-partial-messages --model <m> --no-session-persistence
  --system-prompt <...> --permission-mode bypassPermissions`. Parses newline-
  delimited JSON, forwards `content_block_delta.text_delta` events to an `onDelta`
  callback, skips `thinking_delta` and `signature_delta`. Reads authoritative
  token usage from the final `result` event (including cache read/creation tokens).
  Detects hangs via a configurable stream-idle timeout (SIGTERM → SIGKILL after
  5s). Supports abort via `AbortSignal` for `/cancel`.
- **Session executor** (`src/agent/session.ts`) — one function orchestrating
  the lifecycle: insert session + user message, assemble prompt, run claude,
  persist final assistant message + session status. Records `transient_api_error`
  audit rows on 503/529 from the API.
- **Context assembly** (`src/agent/context.ts`) — builds the system prompt in
  the spec's order (base + memory + skills + meta + conversation history).
  Embeds history in the prompt rather than via `--input-format stream-json`;
  see README § Design Decisions for the trade-off. Memory and skills are
  placeholders in Phase 2 (empty arrays); wired properly in Phase 3.
- **Per-chat queue** (`src/agent/queue.ts`) — `ChatRunner` runs tasks
  sequentially with FIFO order, supports cancel (aborts current, drops queued,
  calls `onDrop` for user notification). `QueueManager` maps chat id → runner
  and exposes `depths()` for the heartbeat snapshot. Unit tests cover sequential
  execution, cancel-while-running, multi-chat isolation.
- **Budget tracker** (`src/agent/budget.ts`) — computes the current daily
  window in the configured timezone (handles DST correctly, verified with
  2026-03-29 Europe/Zurich spring-forward test), queries `sessions.tokens_used_between`
  for the used count. Gates new sessions at `dailyTokenLimit`. Per-session cap
  exists in the config for Phase 2 but is tracked post-hoc in the DB rather
  than enforced mid-stream.
- **Full sessions + messages repositories** — `create / update / get / list /
  markRunningAsOrphaned / tokensUsedBetween` on sessions; `insert /
  setTelegramMessageId / latestByChat / byChatSince` on messages. The orphan
  sweep now returns distinct chat ids so the startup notice can address
  everyone whose session was interrupted.
- **Telegram auth** (`src/telegram/auth.ts`) — strict DM allowlist from
  `telegram.dm.allowedUserIds`, group/channel/unknown paths rejected with
  an `unauthorized_access` audit entry.
- **Telegram streaming sink** (`src/telegram/streaming.ts`) — batches deltas,
  edits a single Telegram message every `telegram.streamEditIntervalMs`
  (default 1200ms) subject to a rolling 18-edits-per-60s limiter (buffer
  against Telegram's 20/min cap). Auto-continuation when a message would
  exceed ~3900 chars. Sends `chatAction: 'typing'` every 5 s while streaming.
  Swaps in a `⏳ Still working…` message when `longTaskNotifyAfterMs` passes
  without a delta. Final edit is un-throttled and prepends an error line
  (`⚠️ Task failed (exit N). Retry: /retry <id>`) on non-clean exits.
- **Command handlers** (`src/telegram/handlers/commands.ts`) — `/start`,
  `/help`, `/status` (budget snapshot), `/cancel` (aborts current + drops
  queued in this chat), `/retry <session-id>` (starts a new session with
  the original user input of any past failed/cancelled session from this
  chat).
- **DM handler** (`src/telegram/handlers/dm.ts`) — sends the opening
  `⏳ Working…` (or `⏳ Queued (position N)…` if the chat is busy), creates
  the session id up front, builds the sink, and submits to the queue. The
  `onStart` callback edits `⏳ Queued…` → `⏳ Working…` when the task
  actually begins.
- **Group reject handler** (`src/telegram/handlers/group.ts`) — writes an
  audit row and replies with a rejection. Group support is PLANNED but
  disabled in v1 per spec.
- **Bot wiring** (`src/telegram/bot.ts`) — grammy bot with auth middleware,
  queue manager, command + DM + group-reject handlers, error-bus → principal
  DM forwarding, polling lifecycle (start/stop/notifyPrincipal).
- **Graceful shutdown upgrade** (`src/index.ts`) — SIGTERM stops Telegram
  polling, waits up to 30s for in-flight sessions, then force-closes. Any
  sessions still in-flight past the deadline are left for the next boot's
  orphan sweep.
- **Post-boot orphan notice** — when the orphan sweep found ≥1 interrupted
  session on startup, the bot sends one aggregated DM to the principal:
  `ℹ️ Service restarted. N session(s) interrupted.`.
- **Error-bus → Telegram** — listeners subscribe to `error:reported` from the
  event bus and forward to the principal (or `observability.errorChatIdOverride`)
  when `observability.errorsToTelegram` is true.
- **Heartbeat snapshot now includes live queue depths per chat** and a
  reconciled `active_sessions` count derived from queue state.
- **Integration test** (`tests/integration/runner.e2e.test.ts`) — real Claude
  CLI end-to-end. Gated behind `CLAUDE_E2E=1` so CI doesn't incur API cost.
  Verified locally: session completes, tokens recorded, user + assistant rows
  persisted.

### Deferred (Phase 2 → later)

- **Conversation history via canonical multi-turn** — Phase 2 embeds history
  in the system prompt; later phases may switch to `--input-format stream-json`
  once we have a clean multi-turn feeding strategy.
- **Per-session token limit enforcement mid-stream** — currently post-hoc:
  we record the final usage and flag in audit if it exceeds the limit, but
  don't kill a streaming session early. Adding mid-stream enforcement
  requires parsing usage from intermediate `message_delta` events.
- **Memory and skills in context assembly** — Phase 3 wires the real sources.
  Phase 2 passes empty arrays.
- **Schedule kinds / loop protection / per-schedule budgets** — Phase 4.

### Added — Phase 1 (Skeleton & Infrastruktur)

- Project scaffolding: pnpm, TypeScript strict, ESLint, Prettier, Vitest.
- Directory structure per spec; `data/` and all empty subdirs tracked via `.gitkeep`.
- Config loader (`src/config/load.ts`) with YAML parsing and Zod validation.
- Config schema (`config/config.schema.ts`) — single source of truth for the config shape,
  list of hot-reloadable vs restart-required fields, and parsing helpers.
- SIGHUP reload handler (`src/config/reload.ts`) that diffs old vs new config and
  applies hot-reloadable fields in-place while logging warnings for restart-required
  changes.
- Scoped secrets module (`src/config/secrets.ts`): `getSecret(name, { scope })` with
  hard-coded core allowlist and audit-log entry on scope violation.
- SQLite persistence (`src/db/index.ts`) with migration runner and migration
  `0001_init.sql` covering all tables from the spec (sessions, messages, memory,
  schedules, schedule_runs, heartbeats, audit, schema_version).
- Minimal repository helpers for `audit` (used by secrets) and `heartbeats` (used
  by observability). Full repositories land in later phases per spec.
- Pino JSON-lines logger (`src/observability/logger.ts`) with redaction for known
  secret keys and `*token*`/`*secret*`/`*password*`/`*api_key*` patterns, writes
  to `data/logs/andybioticlaw.log` in prod, pino-pretty in dev.
- Typed event bus (`src/events/bus.ts`) with strongly-typed emit/on helpers.
- Credentials check (`src/agent/credentials.ts`) — uses `claude auth status --json`
  as the primary method (design decision — see README § Design Decisions), falls
  back to file-existence check if the CLI is unavailable. Service boots even on
  failure; dashboard and CLI remain usable.
- Heartbeat scheduler (`src/observability/heartbeat.ts`) — writes to `heartbeats`
  table every `observability.heartbeatIntervalSec`.
- Skills loader scaffold (`src/skills/loader.ts`) — scans `skills/`, ignores
  `_template` and `_*`-prefixed entries. No real loading logic in Phase 1;
  logs `0 skills loaded` and returns an empty registry.
- CLI (`src/cli/admin.ts`, commander-based). Phase 1: `config validate`
  and `config reload` (sends SIGHUP to the daemon via `pidfile`) are functional.
  Other subcommands are declared but exit with `not yet implemented in phase 1`.
- systemd unit template (`systemd/andybioticlaw.service`).
- install.sh skeleton (`scripts/install.sh`) with TODO markers for Hetzner steps.
- Dev bootstrap script (`scripts/bootstrap-dev.sh`).
- Backup skeleton (`scripts/backup.sh`) — wraps SQLite `.backup` API.
- Skills contract documentation (`skills/README.md`) and `_template` skill.
- README with dev-setup and Hetzner deployment placeholders.
- Smoke test for config validation (`tests/unit/config.test.ts`).

### Deferred (tracked for later phases)

- Telegram bot integration — Phase 2.
- Agent-runner / Claude CLI subprocess management — Phase 2.
- Per-chat queue, streaming sink, conversation-history assembly — Phase 2.
- Real memory manager with TTL cleanup and Telegram inline-button proposals — Phase 3.
- Skill manifest parsing, install/uninstall lifecycle, scoped secret injection,
  MCP config generation per session — Phase 3.
- Scheduler engine (bash/http-check/agent-task/reminder), loop-protection,
  per-schedule budgets — Phase 4.
- Fastify dashboard + Vite/React frontend + WebSocket log stream — Phase 5.
- Production install.sh (user creation, permissions, logrotate), integration tests,
  Hetzner deployment doc — Phase 6.
