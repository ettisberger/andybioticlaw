# Security posture

**tl;dr** — andybioticlaw is a single-principal personal agent. The
config file, `.env`, and the service user's shell are all at the same
privilege level. The service hardens against accidents and silent billing
switches, not against a malicious principal.

## Trust boundaries

### Inside the boundary (trusted)

- Whoever can edit `config/config.yaml`.
- Whoever can edit `.env`.
- Whoever can place files in `skills/`.
- Whoever holds the `andybioticlaw` service user's shell.

These are all treated as **the principal**. They can:

- Run arbitrary shell commands on the host via `schedule add --kind bash`.
- Inject arbitrary content into Emma's system prompt via memory / skills.
- Read any DM transcript (via the dashboard or SQLite directly).
- Read and alter every audit row.

**This is by design.** The service is a personal agent; the operator
IS the user.

### Outside the boundary (untrusted)

- Telegram users NOT in `telegram.dm.allowedUserIds` → rejected with an
  `unauthorized_access` audit entry.
- Group chats / channels (even if the bot is added) → rejected in v1.
- HTTP clients reaching the dashboard that don't present valid
  basic-auth credentials (if `dashboard.basicAuth.enabled: true`).
- The open internet, unless the operator explicitly exposes the
  dashboard via reverse proxy (see `docs/DEPLOYMENT.md` § 10).

## Enforcement layers

### 1. Subscription-only Claude auth (never API-key billing)

The `claude` CLI happily switches to pay-as-you-go API-key billing if
`ANTHROPIC_API_KEY` is set in its environment — silently, with no
user-visible signal. We accept two subscription-bound auth paths —
keyring session (`claude login`) and long-lived OAuth token
(`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) — and block the
pay-as-you-go API-key path at three independent points:

- **Startup**: `checkClaudeCredentials()` parses `claude auth status
  --json` and refuses on a **reject-list** (`API_KEY_SOURCE_REJECT` =
  `{'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'}`) + missing
  `subscriptionType`. The auth method (`session` / `token` / `unknown`)
  is derived and surfaced on the dashboard. Unknown-but-not-rejected
  `apiKeySource` values are logged at WARN + audited as
  `unknown_api_key_source` so future CLI changes are observable.
- **Subprocess env filter**: `buildClaudeEnv()` strips
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_API_URL`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX` from every `claude` subprocess we spawn.
  `CLAUDE_CODE_OAUTH_TOKEN` is deliberately not on this list — it's
  subscription-bound, same billing path as a session.
- **Runtime assertion**: every session inspects the `apiKeySource`
  field on the CLI's `system/init` event. If the observed value is in
  `API_KEY_SOURCE_REJECT` → SIGKILL the subprocess + audit
  `api_key_billing_blocked` + session fails.

Why a reject-list instead of a one-value accept-list (`'none'` only):
the exact `apiKeySource` reported when the CLI is using
`CLAUDE_CODE_OAUTH_TOKEN` isn't publicly documented, and a one-value
accept-list would boot-lock on a future CLI version change. Rejecting
only the known API-key sources is conservative on billing without being
fragile on implementation details.

Live-verified in `tests/integration/runner.e2e.test.ts`: with
`ANTHROPIC_API_KEY=sk-ant-BOGUS` set in the test process, the
subprocess's reported `apiKeySource` is never in the reject-list.

**April 2026 caveat.** Anthropic enforced against third-party 24/7
agent harnesses (openclaw precedent) on subscription credentials.
`setup-token` remains supported and both auth paths still work
technically; enforcement is heuristic (abuse classifier) rather than
documented policy. Always-on self-hosted operation on subscription
auth carries residual risk of throttling or brief suspension.

### 2. Scoped secrets (skill-level isolation)

Skills declare `required_secrets` in their `manifest.yaml`. At runtime,
`getSecret(name, context)` throws `SecretScopeViolationError` — and
writes an `audit.kind='secret_scope_violation'` row — if:

- the `context` is `'core'` and `name` isn't in the hard-coded
  `CORE_SECRETS` list (currently just `TELEGRAM_BOT_TOKEN`), OR
- the `context` is `{ skill: 'X' }` and `name` isn't in skill X's
  manifest.

Skill secrets are **never** injected into other skills' MCP server
env blocks: `buildMcpConfig()` interpolates `${SECRET_NAME}` templates
only for secrets declared in that server's own skill.

#### 2a. Skill visibility — per-agent + per-context

The set of skills an agent can use in a given chat is the
intersection of three filters, applied at session start by
`registry.activeForAgent(scope, agent.skills, policy.skillsVisible)`:

1. The skill is `enabled` (operator toggle in CLI / dashboard).
2. The skill's `scope` includes the session's scope (`dm` or
   `group`).
3. The agent's `skills` config (`['*']` = every enabled skill;
   explicit list = subset). Configured per-agent in `config.yaml`.
4. The resolved policy's `skillsVisible` (`['*']` = no narrowing;
   explicit list = subset of the agent's skills, by chat). Loaded
   fresh from `data/policies.json` for each session via
   `<agentId>:<channel>:<chatId>`.

Both filters are enforced — a skill that's enabled globally and
allowed for an agent can still be hidden from a specific chat by
that chat's `policy.skillsVisible`. Useful when the same agent
serves multiple groups but you want a tighter skill set in some
of them.

### 3. Per-session subprocess env

Every `claude` spawn gets:

```
env = buildClaudeEnv(process.env)       // strips billing vars
    + extraEnv                           // scoped skill secrets only
```

The parent service's entire env is NOT inherited blindly. A stray
env var that names a secret can't leak into Claude's tool
environment unless a skill explicitly declares it.

### 4. SQL injection — parameter-bound values, allowlisted keys

All `.prepare()` calls use named parameters (`@id`, `@name`, …) — 100%
of user-provided values go through SQLite's binding. Three repos
(`sessions`, `memory`, `schedules`) build SET clauses dynamically from
`Object.keys(patch)`; those keys are now filtered through an explicit
allowlist per repo (defense-in-depth against a future untyped caller).

A regression test suite (`tests/unit/repo-update-allowlist.test.ts`)
exercises each repo by passing keys like
`"tokens_input = 0; DROP TABLE sessions; --"` and asserts they're
silently ignored and tables are intact afterward.

### 5. File permissions

| Path | Mode | Enforced by |
|---|---|---|
| `data/andybioticlaw.db` | 0600 | `openDatabase()` (chmod at open) |
| `data/andybioticlaw.pid` | 0600 | `writeFileSync(..., { mode: 0o600 })` |
| Per-session `.mcp.json` | 0600 | `writeMcpConfig()` |
| `data/` (prod) | 0700 | `install.sh` |
| `/home/andybioticlaw/.andybioticlaw` (prod) | 0700 | `install.sh` |

### 6. Log + dashboard redaction

- Pino redacts `*.token`, `*.secret`, `*.password`, `*.api_key`,
  `authorization`, plus known core env keys by value-replacement
  (`[REDACTED]`) at write time.
- Dashboard `/api/config` additionally redacts
  `dashboard.basicAuth.passwordHash` before serializing.

### 7. Systemd sandboxing (prod)

The bundled unit (rendered at install-time from `systemd/andybioticlaw.service.template`) enables:

- `ProtectSystem=strict` (filesystem is read-only except explicit
  `ReadWritePaths`),
- `ProtectHome=read-only` (the service can read `~/.claude` for
  subscription creds but can't write anywhere under `/home`),
- `PrivateTmp=yes`,
- `NoNewPrivileges=yes`,
- `Restart=on-failure` with `StartLimitInterval=300` +
  `StartLimitBurst=3` — a service that crashes 3× in 5 min gets
  left down rather than flap-looping.

## Specific trust notes

### `bash` schedules are shell commands, by design — but gated against agent-created additions

`schedule add --kind bash --payload '{"command": "…"}'` runs the
command via `/bin/sh -c <command>` as the `andybioticlaw` service user,
with full filesystem access granted by systemd's `ReadWritePaths=
/home/andybioticlaw/.andybioticlaw/data` and the service user's normal shell
privileges.

This is **shell injection** — acceptable *when the principal authored
the payload*. Since Emma was given shell access (via Bash tool) and the
ability to invoke this CLI, a prompt injection (email contents, web
fetch, skill output, etc.) could otherwise talk her into creating a
bash schedule that survives restarts. The CLI therefore gates schedule
creation against the per-context policy in `data/policies.json`.

- The harness sets `ANDYBIOTICLAW_CONTEXT_KEY=<agentId>:telegram:<chatId>`
  in Emma's session env. The CLI reads this var, looks up the
  resolved policy, and rejects any kind not in `policy.scheduleKinds`.
- The principal's interactive shell has no `ANDYBIOTICLAW_CONTEXT_KEY`
  set → gate is bypassed entirely (principal acting directly).
- The default principal-DM policy allows `reminder` + `agent-task`;
  group-chat policies are typically tighter (`reminder` only).
- agent-task creation is additionally capped at
  `policy.scheduleAgentTaskCap` (default 20) to bound runaway
  prompt-injection loops.
- Every schedule Emma successfully creates is logged as
  `schedule_created_by_agent` (with the resolved context key in the
  detail) so suspicious activity is post-hoc inspectable.

Do NOT:

- Source `bash` schedule payloads from untrusted input (e.g., a web
  form, an external API).
- Expose a config-editing endpoint on the dashboard (we don't —
  `/api/config` is read-only and masked).
- Set `ANDYBIOTICLAW_CONTEXT_KEY` in the service's systemd unit or in
  any file the daemon reads at startup — that would shadow the
  per-session value the harness injects.

### Dashboard is localhost-only by default, with defense-in-depth

`dashboard.host: 127.0.0.1` is the shipped default, and
`dashboard.basicAuth.enabled: true` is the shipped default too (the
service refuses to start without a `passwordHash` — populated by
`andybioticlaw init`). The Fastify app ALSO enforces a double-submit
CSRF token on mutating requests (POST/PUT/PATCH/DELETE): the
`_abl_csrf` cookie is set on every GET with `SameSite=Strict`, and
the `X-CSRF-Token` header on mutating calls must match. `/healthz` is
exempt so monitoring tools don't need credentials or tokens.

**If you reverse-proxy the dashboard over the internet** (deployment
doc § 10b):

- TLS termination at nginx (`certbot --nginx`).
- CORS deny by default at nginx, or a network-level IP allowlist.
- Consider `fastify-rate-limit` if you want to throttle auth attempts.

The dashboard exposes **full session transcripts** to any
authenticated viewer. That's expected for a single-principal setup;
it becomes worth reconsidering if multiple principals are ever
added (out of v1 scope).

### Memory proposals via MCP write to the shared DB

The memory-proposal MCP server (`src/mcp/memory-proposal-server.ts`)
opens `data/andybioticlaw.db` directly from a subprocess and writes
to `memory_proposals`. A malicious skill cannot hijack this because
skills can't declare or spawn the `andybioticlaw-memory` server —
it's wired in by the core engine with a hard-coded name. Name
collisions from a skill trying to steal the name are detected
(`buildMcpConfig()` warns + drops the duplicate).

### Telegram bot uses long-polling, not webhooks

No public endpoint to expose → no webhook signature validation to
maintain. The tradeoff: a single `getUpdates` long-poll is exclusive,
so running two bots with the same token will interleave messages.

## What is NOT enforced (accepted risks)

- **No 2FA** for Telegram. Telegram itself does the authentication;
  we just allowlist `user_id`s.
- **No per-user quota** beyond the global daily budget. One
  principal, one budget.
- **No retention limit on messages / sessions** beyond heartbeat (7
  days). Conversation history accumulates forever in SQLite — fine
  for a personal setup at ~100MB/year growth; revisit if scale
  changes.
- **No integrity check on memory proposals**: if a malicious skill
  ran in-process and had direct DB access (which skills don't — they
  talk via MCP only), it could forge proposals. Current skill model
  forbids in-process execution.

## Incident response

If you suspect any of the following, take immediate action:

| Suspected event | Action |
|---|---|
| Leaked Telegram bot token | `/revoke` via @BotFather, rotate in `.env`, `systemctl restart andybioticlaw` |
| Leaked Claude subscription creds (session) | `claude logout` + `claude login` on the VPS as the service user; restart |
| Leaked CLAUDE_CODE_OAUTH_TOKEN | revoke via `claude setup-token --revoke` (or the Anthropic web console), generate a fresh one via `claude setup-token`, update `.env` on the VPS, `systemctl restart andybioticlaw` |
| `ANTHROPIC_API_KEY` accidentally set in prod env | `systemctl stop andybioticlaw`; unset the var; restart. Verify boot log shows `apiKeySource` NOT in the reject-list (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) |
| Unknown audit row kind you can't account for | Open `docs/SECURITY.md` + `CHANGELOG.md`, grep the kind name. If it looks agent-originated, consider the current session's conversation log (dashboard `Sessions` page) |
| Suspected DB tampering | Compare `data/andybioticlaw.db` against the most recent off-host backup you maintain (see `docs/DEPLOYMENT.md` § 9); SQLite's `.dump` is textually diffable |

## Reporting

This is a single-principal tool with no upstream — report issues to
your own backlog. If you find a security issue in a dependency, we
inherit it; `pnpm audit --prod` runs clean as of the last audit. See
`CHANGELOG.md` for deployed versions.
