# andybioticlaw

A personal AI agent service with a Telegram frontend and a Claude CLI backend. Runs as a single systemd unit on a Hetzner VPS (or locally for dev). Designed as a leaner successor to OpenClaw/NanoClaw: one DM user, one host process, one SQLite file. No Docker, no multi-agent router, no dead-letter queue.

The default agent identity is **Emma**; the service is named **andybioticlaw**. Both are configurable.

> **Status: Phase 3 — memory + skill infrastructure.** On top of Phase 2: active memory is injected per session (scope-aware), the agent can propose new memory via a real MCP tool (the user accepts or dismisses with an inline button), skills are loaded from manifests, and a per-session `.mcp.json` composes our memory-proposal server with any active skill's MCP servers. Scoped skill secrets are injected into the Claude subprocess. Scheduler and dashboard land in later phases (see `CHANGELOG.md`).

## Requirements

- Node.js 20 LTS or newer (developed on 24, targets 20).
- pnpm 9+ (enable via `corepack enable pnpm` if not already installed).
- A working `claude` CLI authenticated with a Claude subscription. Run `claude login` once as the user that will run the service. On macOS, the credential lives in the system Keychain; on Linux, in `~/.claude/`.

## Dev setup

```bash
# 1. Install deps + copy example configs
./scripts/bootstrap-dev.sh

# 2. Edit config/config.yaml and .env to taste
$EDITOR config/config.yaml

# 3. Run the service (auto-reloads on file change)
pnpm dev

# Other useful commands:
pnpm cli -- config validate    # sanity-check config
pnpm cli -- config reload      # SIGHUP the running daemon
pnpm test                      # run unit tests
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # eslint .
pnpm build                     # compile to dist/
```

Expected first run in dev:

```
[HH:MM:SS.mmm] INFO: andybioticlaw starting (agent: Emma, model: claude-opus-4-7)
[HH:MM:SS.mmm] INFO: applied migration { file: '0001_init.sql', version: 1 }
[HH:MM:SS.mmm] INFO: claude credentials OK
[HH:MM:SS.mmm] INFO: 0 skills loaded
[HH:MM:SS.mmm] INFO: ready
```

If the credentials check fails, the service stays up — you'll see an `ERROR` with a hint and the issue logged to `audit`. Fix it (`claude login`) and restart.

## Configuration

`config/config.yaml` is the authoritative runtime config. See `config/config.example.yaml` for the full schema. Validation lives in `config/config.schema.ts` (Zod).

Secrets live in `.env` — see `.env.example`. Never commit `.env`. Only a short hard-coded allowlist (`TELEGRAM_BOT_TOKEN`, `DASHBOARD_BASIC_AUTH_PASSWORD`) is readable by the core service; skill-specific secrets must be declared in the skill's `manifest.yaml` under `required_secrets` and are otherwise inaccessible.

### Hot reload

Send `SIGHUP` (or run `andybioticlaw config reload`) to re-read `config/config.yaml` without restarting. Fields that can be hot-reloaded are listed in `config/config.schema.ts` (`HOT_RELOADABLE_PATHS`); everything else logs a warning and is ignored until a full restart.

## Hetzner deployment (Phase 6 — placeholder)

The production story is not yet complete. Rough shape for now:

1. Fresh Ubuntu 24.04 VPS.
2. Install Node.js 20 LTS, SQLite, `claude` CLI.
3. Create a system user `andybioticlaw` with a real home dir.
4. Log in as that user once: `sudo -u andybioticlaw -H bash -lc 'claude login'`.
5. Rsync a built release into `/opt/andybioticlaw` (`dist/`, `node_modules/`, `config/`, `skills/`, `systemd/`).
6. `sudo bash /opt/andybioticlaw/scripts/install.sh` installs the systemd unit.
7. Populate `/opt/andybioticlaw/config/config.yaml` and `/opt/andybioticlaw/.env`.
8. `sudo systemctl enable --now andybioticlaw`.

A full, battle-tested `install.sh` (with logrotate, backups, health checks) lands in Phase 6.

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
├── scripts/              install, bootstrap, backup
├── tests/                unit + integration
├── web/                  Phase 5 frontend (Vite/React)
└── data/                 gitignored — SQLite DB, logs, backups, workspaces
```

## Design decisions

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

The service is designed to run on a Claude subscription (Pro/Max), never on pay-as-you-go API-key billing. The `claude` CLI, however, will silently prefer `ANTHROPIC_API_KEY` over its stored subscription credential if the env var is present. To make accidental-API-billing impossible:

1. **Startup check** (`src/agent/credentials.ts`): we parse `apiKeySource` and `subscriptionType` from `claude auth status --json`. Anything other than `apiKeySource: "none"` with a truthy `subscriptionType` is rejected — the service boots but refuses to handle messages.
2. **Subprocess env filter** (`buildClaudeEnv()` in `src/agent/runner.ts`): every time we spawn `claude`, we strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` from the inherited environment — even if they somehow got set in our parent process, the subprocess never sees them.
3. **Runtime assertion**: the CLI's `system/init` event reports `apiKeySource`. If it's anything but `"none"` on a live session, we SIGKILL immediately and fail the session with an `api_key_billing_blocked` audit row.

The E2E test proves the chain: with `ANTHROPIC_API_KEY=sk-ant-BOGUS` set in the test process, the spawned `claude` still reports `apiKeySource: "none"` and runs on the subscription.

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
