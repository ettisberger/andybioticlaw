# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses semantic-ish versioning during pre-1.0 development.

## [Unreleased]

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
