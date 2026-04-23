# andybioticlaw

A single-operator, self-hosted AI agent: Telegram on the front, the Claude CLI (subscription auth) on the back, one SQLite file, one systemd unit. Think of it as a private "Emma" that texts you back — runs schedules, remembers things across sessions, uses MCP skills — but the whole surface is one `systemctl` service under your control.

> Designed as a leaner successor to OpenClaw/NanoClaw: one DM user, one host process, one SQLite file. No Docker, no multi-agent router, no dead-letter queue. The default agent identity is **Emma**; the service is named **andybioticlaw**. Both are configurable.

## Requirements

- A Linux server (any VPS — tested on Ubuntu 24.04). 1 vCPU + 2 GB RAM is comfortable; it's I/O-bound, not CPU-bound.
- Node.js 20 LTS or newer.
- `claude` CLI authenticated against a Claude Pro/Max subscription (not an API key — the service actively refuses API-key billing).
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) and your Telegram numeric user id (from [@userinfobot](https://t.me/userinfobot)).

## Install (from release)

```bash
# 1. Download and extract the latest release:
curl -fsSL -o /tmp/andybioticlaw.tar.gz \
  https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz
mkdir ~/andybioticlaw && cd ~/andybioticlaw
tar xzf /tmp/andybioticlaw.tar.gz --strip-components=1

# 2. Install (creates the `andybioticlaw` system user, systemd unit, logrotate):
sudo bash scripts/install.sh

# 3. As the service user, log into Claude and run the setup wizard:
sudo -iu andybioticlaw
claude login                                    # one-time, OAuth in browser
andybioticlaw                                   # interactive menu → "Run setup wizard"
exit

# 4. Start the service:
sudo systemctl start andybioticlaw
sudo journalctl -u andybioticlaw -f
```

DM your bot and you should get an answer.

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the production-ready walkthrough (SSH hardening, UFW, backups, dashboard reverse-proxy with TLS + basic-auth).

## Update

Releases are versioned. To upgrade a release-tarball install, re-download and re-run the installer — it's idempotent and preserves `data/` + `config/`:

```bash
cd ~/andybioticlaw
curl -fsSL -o /tmp/andybioticlaw.tar.gz \
  https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz
tar xzf /tmp/andybioticlaw.tar.gz --strip-components=1
sudo bash scripts/install.sh
sudo systemctl restart andybioticlaw
```

For installs made from a `git clone` (dev workflow), `andybioticlaw update` still works — it runs `git pull --ff-only` + rebuild + prune. See `src/cli/update.ts`.

## Uninstall

```bash
sudo systemctl stop andybioticlaw
sudo systemctl disable andybioticlaw
sudo rm /etc/systemd/system/andybioticlaw.service /etc/systemd/system/andybioticlaw.service.d -rf
sudo rm /etc/logrotate.d/andybioticlaw
sudo rm /usr/local/bin/andybioticlaw

# Optional — remove the service user and its data (irreversible):
sudo userdel --remove andybioticlaw
```

## Dev setup (contributors / running from a clone)

```bash
git clone https://github.com/ettisberger/andybioticlaw.git
cd andybioticlaw
./scripts/bootstrap-dev.sh         # install deps + copy example configs
$EDITOR config/config.yaml
pnpm dev                           # watch-mode service
```

Other useful commands:

```bash
pnpm test                          # unit tests
pnpm typecheck                     # tsc --noEmit
pnpm lint                          # eslint .
pnpm build                         # compile to dist/
pnpm cli -- config validate        # sanity-check config.yaml
pnpm cli -- config reload          # SIGHUP the running daemon
```

Expected first run in dev:

```
[HH:MM:SS.mmm] INFO: andybioticlaw starting (agent: Emma, model: claude-opus-4-7)
[HH:MM:SS.mmm] INFO: applied migration { file: '0001_init.sql', version: 1 }
[HH:MM:SS.mmm] INFO: claude credentials OK
[HH:MM:SS.mmm] INFO: 0 skills loaded
[HH:MM:SS.mmm] INFO: ready
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the commit-message convention (required — release notes are auto-generated from commit headers) and the PR workflow.

## Configuration

`config/config.yaml` is the authoritative runtime config. See `config/config.example.yaml` for the full schema. Validation lives in `config/config.schema.ts` (Zod).

Secrets live in `.env` — see `.env.example`. Never commit `.env`. Only a short hard-coded allowlist (currently just `TELEGRAM_BOT_TOKEN`) is readable by the core service; skill-specific secrets must be declared in the skill's `manifest.yaml` under `required_secrets` and are otherwise inaccessible. The dashboard's basic-auth password is argon2-hashed by `andybioticlaw init` into `config.yaml` — no plain password is ever stored.

### Editing config interactively

Run `andybioticlaw config edit` (or `andybioticlaw settings`, or pick "Edit settings" from the menu) for an arrow-key TUI over the most-tweaked fields: model, budgets, retention, log level, allowed Telegram users, dashboard enable + auth + password. Hot-reloadable changes SIGHUP the daemon automatically; restart-required changes print the `systemctl restart` hint.

### Hot reload

Send `SIGHUP` (or run `andybioticlaw config reload`) to re-read `config/config.yaml` without restarting. Fields that can be hot-reloaded are listed in `config/config.schema.ts` (`HOT_RELOADABLE_PATHS`); everything else logs a warning and is ignored until a full restart.

## Quickstart (30 min)

See **[docs/QUICKSTART.md](docs/QUICKSTART.md)** — happy-path walkthrough from bare VPS to bot-answering-its-first-DM. No hardening detours, uses `andybioticlaw init` for interactive config.

## Directory tour

```
andybioticlaw/
├── src/                  service source
│   ├── index.ts          entry point
│   ├── cli/admin.ts      `andybioticlaw` CLI
│   ├── config/           config loader, SIGHUP reload, secrets scoping, paths
│   ├── db/               SQLite + migrations + repositories
│   ├── agent/            Claude CLI credentials check, prompts (Phase 2: runner, queue, context)
│   ├── telegram/         Phase 2
│   ├── scheduler/        Phase 4
│   ├── dashboard/        Phase 5
│   ├── skills/           loader + registry (Phase 3: full lifecycle)
│   ├── memory/           Phase 3
│   ├── observability/    logger, heartbeat, error reporter
│   └── events/           typed event bus
├── config/               Zod schema + example config
├── skills/               user-authored skills + README with the skill contract
├── systemd/              unit file for prod
├── scripts/              install, bootstrap
├── tests/                unit + integration
├── web/                  Phase 5 frontend (Vite/React)
└── data/                 gitignored — SQLite DB, logs, per-session workspaces
```

## Security posture

See **`docs/SECURITY.md`** for the full posture document. Headline items:

- The **config file + `.env` + skills dir are the security boundary**. Whoever can edit them can run shell as the service user. This service is a personal single-principal agent; hardening is against *accidents* (e.g., a leaked `ANTHROPIC_API_KEY` silently switching billing), not against a malicious principal.
- `bash` schedule payloads run under `/bin/sh -c <command>` as the `andybioticlaw` service user. This is by design: the scheduler author IS the principal. Never populate `payload.command` from an untrusted source (a web form, external webhook, agent-generated content).
- Subscription-only Claude auth enforced at three layers (see § Design Decisions below).
- Dashboard defaults to `127.0.0.1:18790` with no CSRF/rate-limit. If you reverse-proxy it publicly, add TLS + network-level restrictions per `docs/DEPLOYMENT.md` § 10b.

## Design decisions

### Scheduler shares the per-chat queue, doesn't bypass it (Phase 4)

A schedule-fired agent session goes through the same `QueueManager` as a DM. If you're actively chatting with Emma when a scheduled `agent-task` or chained-bash fires on the same chat, the scheduled task queues behind your message — it doesn't preempt or run in parallel. Tradeoff: one scheduled session can't run while a DM is active, so slow DMs delay schedules. Benefit: no message interleaving, no cross-talk on shared conversation state.

### Scheduler has two SIGHUP handlers, one for config, one for DB (Phase 4)

`createReloadController.onReload` only fires when *config* fields change. CLI commands like `schedule add` modify the DB, not config, so the reload controller wouldn't notice. A dedicated `process.on('SIGHUP', () => scheduler.refresh())` covers the DB-change case. Both handlers fire on one SIGHUP signal — Node dispatches to all registered listeners.

### Loop protection is twofold: consecutive-fails AND rate-window (Phase 4)

`consecutive_fails >= 3` → auto-disable + audit + principal DM. Independently, `>5 runs in 5 minutes` → same auto-disable path. The rate-window catches schedules that succeed quickly but re-fire themselves in a tight loop (bug in a `bash` command that writes `{"trigger": true}` unconditionally). Re-enable via `andybioticlaw schedule enable <id>` once the underlying bug is fixed — `enable` also clears `consecutive_fails`.

### `bash` and `http-check` chain via a trigger envelope, not side effects (Phase 4)

To fire an agent-task from a bash schedule, the command's stdout must be JSON matching `{"trigger": true, "prompt": "..."}`. Anything else — including stdout containing the word "trigger" as prose — does NOT spend tokens. This keeps the "free polling, expensive decision-making" split clean: poll-heavy checks (daily backup, disk usage, mailbox count) run thousands of times before ever firing Claude.

### Memory proposals flow through a real MCP tool, not a text marker (Phase 3)

The spec says the agent proposes memory entries via a tool-call. We expose a stdio MCP server (`src/mcp/memory-proposal-server.ts`) that implements one tool, `memory_propose(scope, value, key?, ttl_seconds?)`. The Claude CLI learns about it via the per-session `.mcp.json` we generate — the tool name the agent sees is `mcp__andybioticlaw-memory__memory_propose`.

The MCP server is its own Node subprocess. It talks to the same SQLite DB as the main service via WAL (concurrent readers and one writer at a time). On call, it writes a row into `memory_proposals` with status `pending`; the main service's streaming sink scans for pending proposals after the session ends and either auto-accepts them (when `memory.autoAccept: true`) or sends inline buttons.

Why a real MCP tool over a structured-marker-in-response convention: tools are a first-class primitive the model understands natively, the tool call is structured and validated (scope regex, required `value`), and we get free interop with the rest of the MCP ecosystem — including any skill that wants to expose its own tools the same way.

### Skill MCP servers are composed into the same `.mcp.json` as our memory server

Each active skill's `manifest.yaml` can declare one or more `mcp_servers`. When a session starts, we build a single `.mcp.json` that merges our `andybioticlaw-memory` entry with every active skill's servers (skills filtered by `enabled && scope.includes(sessionScope)`). Secret templates like `${GOOGLE_OAUTH_TOKEN}` in a skill server's env are resolved via the scoped secrets manager — `${SECRET}` only interpolates if it's in that skill's `required_secrets`. Unresolved references become empty strings AND emit warnings so the operator can see a broken skill rather than one that silently runs against a nulled credential.

### Scoped skill secrets are injected into the Claude subprocess env, never into `.mcp.json` for other skills

The runner merges two env sets: `buildClaudeEnv(process.env)` (the API-billing-filtered parent env) and `extraEnv` (per-session scoped secrets). Each active skill's `required_secrets` are resolved through `getSecret(name, { skill: <name> })` — the scoped call that throws `SecretScopeViolationError` + writes a `secret_scope_violation` audit row if the skill tries to read something it didn't declare.

### Memory-proposal MCP server is invoked via `tsx` in dev, `node` in prod

`resolveMemoryServerSpawn()` in `src/index.ts` picks a `{command, args}` pair. In a compiled install (`dist/mcp/memory-proposal-server.js` exists) we spawn `node dist/mcp/memory-proposal-server.js`. In a source install (`.ts` file exists, `node_modules/tsx/dist/cli.mjs` exists) we spawn `node <tsx-cli> src/mcp/memory-proposal-server.ts`. This lets `pnpm dev` work without a prior `pnpm build` while keeping prod clean.

### Subscription auth is enforced at three layers, never API-key billing

The service runs on a Claude subscription (Pro/Max/Team/Enterprise), never on pay-as-you-go API-key billing. Two subscription paths are supported:

- **Keyring session** — what `claude login` produces. Stored on Linux in `~/.claude/.credentials.json` (access-token ~1h, refresh-token months+, auto-refreshes on 401). What you get if you just follow the install wizard and let the service user run `claude login`.
- **Long-lived OAuth token** — what `claude setup-token` produces: a `sk-ant-oat-*` token consumed via the `CLAUDE_CODE_OAUTH_TOKEN` env var, 1-year lifetime, subscription-billed (not API credits). Better for unattended servers because there's no periodic re-login.

Both paths route to the same subscription billing. The thing we actively block is pay-as-you-go API-key billing, because the `claude` CLI will silently prefer `ANTHROPIC_API_KEY` over stored subscription credentials if the env var is present and that would quietly drain the account's credits. To make that impossible:

1. **Startup check** (`src/agent/credentials.ts`): we parse `apiKeySource` and `subscriptionType` from `claude auth status --json`. A **reject-list** (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` — see `API_KEY_SOURCE_REJECT`) + missing `subscriptionType` triggers a boot failure. Any other `apiKeySource` value paired with a truthy `subscriptionType` is accepted. We use a reject-list rather than a one-value accept-list (`'none'`) because the exact `apiKeySource` reported by `CLAUDE_CODE_OAUTH_TOKEN` auth is not publicly documented, and a one-value accept-list would boot-lock on future CLI changes. Unrecognised-but-not-rejected values are logged at WARN + audited as `unknown_api_key_source` for observability.
2. **Subprocess env filter** (`buildClaudeEnv()` in `src/agent/runner.ts`): every time we spawn `claude`, we strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` from the inherited environment. `CLAUDE_CODE_OAUTH_TOKEN` is NOT on the strip list — it's subscription-bound, same billing path as a keyring session, and the CLI needs to see it.
3. **Runtime assertion**: the CLI's `system/init` event reports `apiKeySource`. If it's in the reject-list on a live session, we SIGKILL immediately and fail the session with an `api_key_billing_blocked` audit row.

The E2E test proves the chain: with `ANTHROPIC_API_KEY=sk-ant-BOGUS` set in the test process, the spawned `claude` reports an `apiKeySource` that's **not** in the reject-list (either `'none'` for keyring or the `CLAUDE_CODE_OAUTH_TOKEN` marker) and runs on the subscription.

**April 2026 caveat.** Anthropic enforced against third-party 24/7 agent harnesses (openclaw precedent) running on subscription credentials, arguing subscriptions are for interactive use. `setup-token` is not deprecated and both auth paths still work technically, but operating an always-on self-hosted service on either subscription-auth path is at your own risk — the abuse classifier can throttle or briefly suspend accounts. There's no formal written policy.

### System prompt ordered cache-stable → cache-volatile (post-audit tweak)

`assembleContext()` lays out sections so Anthropic's prompt cache can re-use the maximum possible prefix across turns in the same chat:

1. **Stable prefix** (cache-friendly): base prompt → active memory → installed skills → memory-tool block → stable runtime meta (agent / model / timezone / principal).
2. **Volatile suffix** (busts cache every turn): conversation history → current time.

Two decisions worth calling out:

- **Stable meta has no timestamp.** The `## Runtime context` block used to end with `Current time: YYYY-MM-DD HH:MM:SS`, which busted the cache at that byte boundary on every turn. Current time now lives in its own `## Current time` block at the very end of the prompt — after the (already cache-breaking) conversation history, so moving it costs nothing and moves the cache boundary way forward.
- **Current time is floored to a 15-minute bucket** (`timeBucketMs` default 900 000 ms). A burst of rapid DMs inside the same 15-min window renders byte-identical prompts up to and including the `## Conversation history` block. The time footer notes that the value is bucketed and instructs Emma to run `date -u` (via Bash) when she needs precision. Regression-tested in `tests/unit/context.test.ts`.

Pick a smaller `timeBucketMs` (e.g., `60_000` for 1-min buckets) if Emma needs higher time precision at the cost of more cache misses; larger (e.g., `3_600_000` for hourly) if you want maximum cache hits and you're fine with Emma reaching for Bash whenever she needs seconds.

### Conversation history is embedded in the system prompt, not streamed as multi-turn messages (Phase 2)

The spec phrases "Conversation-History folgt als User/Assistant-Messages." We considered using `claude --input-format stream-json` to pass a true multi-turn transcript. Two reasons we instead embed history inside `--system-prompt`:

1. **CLI shape.** `--input-format stream-json` is designed for *streaming the current user turn's content* (e.g. live from a UI), not for replaying prior assistant turns. The CLI doesn't have a documented schema for feeding arbitrary prior turns.
2. **Simplicity.** One `--system-prompt` arg containing base + memory + skills + meta + transcript makes the runner's contract with Claude explicit, and it survives every CLI version change we've seen. The quality difference on our 50-message histories is negligible in practice.

The caveat lives in CHANGELOG under "Deferred" — we can revisit once `stream-json` input accepts a replay sequence cleanly.

### Claude CLI spawn flags

For each turn we spawn `claude -p <message> --output-format stream-json --verbose --include-partial-messages --input-format text --model <m> --no-session-persistence --system-prompt <assembled> --permission-mode bypassPermissions`.

- `--verbose` is required together with `--output-format stream-json`; the CLI refuses without it.
- `--include-partial-messages` is what turns `content_block_delta` events into live text deltas rather than waiting for the full message.
- `--no-session-persistence` is deliberate — our own `messages` table is source of truth; we don't want the CLI to write a session file anywhere.
- `--permission-mode bypassPermissions` avoids interactive prompts (Telegram has no way to answer them). The principal user is trusted by design.
- We skip `thinking_delta` and `signature_delta` stream events — they're the extended-thinking feed, not user-visible output.
- Final usage is read from the single `result` event. `usage.input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` → `tokens_input`; `output_tokens` → `tokens_output`. Cache tokens count against the daily budget because they're still real input to the model.

### Per-chat queue is sequential; multi-chat runs in parallel

A `ChatRunner` runs tasks FIFO for one chat id. Two messages from the same chat never run concurrently, preventing message interleaving on the Telegram side and race conditions on shared conversation state. Different chat ids each get their own `ChatRunner`, so multiple concurrent users (once we support them) wouldn't block each other.

### Streaming sink batches edits at `streamEditIntervalMs` (default 1200 ms) with a rolling 18-edits-per-60s cap

Telegram enforces ~20 message edits per minute per chat. We leave a two-edit buffer for safety, and skip the flush tick entirely when the rate-limiter is full — we don't queue backpressure on grammy itself. The final edit (on session end) is un-throttled so the user always sees the complete response with the `✍️` suffix removed.

### Credentials check uses `claude auth status --json`, not file existence

The spec leans toward checking that `~/.claude/` contains a credential file. On macOS the `claude` CLI stores its subscription credential in the system Keychain, not in a file under `~/.claude/`, so a naive file-existence check flags a perfectly healthy Mac dev environment as "credentials missing." `claude auth status --json` is the authoritative signal across platforms and also tells us whether the cached token is still valid. We keep a file-existence fallback only as a hint when the CLI itself is unreachable (e.g. not installed for the service user).

### Conversation context is reassembled per turn, not continued via `claude --resume`

Per the brief: the service treats its own `messages` table as source of truth and rebuilds the conversation on every turn, injecting the last N messages from the chat into the prompt. Tradeoff: more tokens per request in exchange for full control — we can prune, rewrite, or summarize without trusting the CLI's opaque session state. `--no-session-persistence` will be set on each spawn (Phase 2).

### Phase 1 does not parse skill manifests

The skill loader scans for the expected folder shape and counts eligible candidates, but does NOT parse manifests or register anything in the registry. This keeps Phase 1's startup surface tiny and keeps us honest about what "0 skills loaded" means at this stage. Manifest parsing and the full install/uninstall lifecycle land with Phase 3 alongside the memory manager.

### SQLite WAL + foreign keys on

`openDatabase()` enables WAL (so the dashboard can read while the service writes) and turns foreign keys on (off by default in better-sqlite3). `synchronous=NORMAL` is a deliberate tradeoff against `FULL` — we accept a very small risk of the last transaction disappearing on a hard crash in exchange for noticeably lower write latency.

### Restart-required vs hot-reloadable fields are enumerated explicitly

Rather than diffing the whole config and guessing which changes are safe to apply, `config.schema.ts` enumerates both sets. A change to an un-enumerated path is treated as a bug (it simply isn't diffed). Adding a new config field requires adding it to exactly one of the two lists — an intentionally annoying step to force the decision.

## Troubleshooting

- **`config error (file-missing)`** on first run — copy `config/config.example.yaml` to `config/config.yaml`.
- **Credentials check fails with `could not query claude CLI`** — make sure the `claude` binary is on the `PATH` of the user running the service. On Linux systemd, set `Environment=PATH=...` in the unit file if Node's `PATH` doesn't include it.
- **SIGHUP silently does nothing** — check `data/andybioticlaw.pid` exists and points to the running process. The CLI's `config reload` command requires the daemon to be up.

## License

MIT. See `LICENSE`.
