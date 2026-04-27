# Architecture

This is the **mental model** of andybioticlaw — one diagram, four data
flows, a pointer to the per-module source, and a link to the decisions
that shaped it. Read this before you start modifying code.

For the *reasoning* behind each choice (why we embed history in the
system prompt, why subscription auth is enforced in three layers, why
the scheduler shares the per-chat queue, etc.) see
**`README.md` § Design decisions**. This file is the shape; that is
the why.

## Component diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                               single Node.js process                       │
│                                                                            │
│   telegram/bot            dashboard/server         cli/admin (short-lived) │
│   (grammy, long-poll)     (Fastify, :18790)        spawned by operator     │
│        │                        │                        │                 │
│        └──────┬─────────────────┴─────┬──────────────────┘                 │
│               │                       │                                    │
│          agent/dispatch           dashboard/routes  ─── read-mostly        │
│               │                                                            │
│          agent/queue    ◄── per-chat FIFO                                  │
│               │                                                            │
│          agent/session  ─► agent/runner ─► spawns `claude` subprocess      │
│               │                               │                            │
│               │                               └─► stdio MCP servers        │
│               │                                   (memory-proposal +       │
│               │                                    any active skill)       │
│               ▼                                                            │
│          memory, skills, scheduler-engine, budget, observability           │
│               │                                                            │
│               ▼                                                            │
│          db/repositories ── SQLite (WAL, FK on, 0600)                      │
└────────────────────────────────────────────────────────────────────────────┘
                 │
                 └─► data/  (logs, per-session workspaces, SQLite DB)
```

One process owns everything. The `claude` subprocess is spawned per
session and dies with it; MCP servers are subprocesses of that Claude
subprocess. Dashboard HTTP, Telegram long-poll, and scheduler cron
ticks all live in the main event loop.

## Data flow 1 — user DM to bot reply

```
Telegram Update
  → grammy handler (telegram/bot.ts)
  → auth.check (telegram/auth.ts)            reject non-allowlisted user
  → dispatch (agent/dispatch.ts)             extracted so /api/sessions/:id/retry can reuse
  → queue.submit(chatId, SessionExecuteInput)
  → ChatRunner executes one at a time per chat
    → executeSession (agent/session.ts)
       - load last N messages from messages-repo
       - snapshot active memory in scope
       - read SKILL.md for each active skill
       - assembleContext → system prompt (cache-stable → cache-volatile layout)
       - buildMcpConfig → .mcp.json with memory-proposal + skill MCP servers
       - runClaude (agent/runner.ts) spawns `claude --system-prompt ... --mcp-config ...`
       - stream text_delta events → streaming sink → Telegram message edits
       - on final `result` event: persist session row + token usage
    → dispatch pending memory-proposals
       (auto-accept OR show Telegram inline buttons)
```

## Data flow 2 — memory proposal

```
Claude subprocess invokes tool `mcp__andybioticlaw-memory__memory_propose`
  → stdio MCP server (src/mcp/memory-proposal-server.ts)
     - separate Node subprocess
     - opens SQLite directly (WAL supports concurrent readers + 1 writer)
     - INSERT into memory_proposals (status='pending')
  → session-end hook (src/memory/proposals.ts) scans pending by session_id
     - if memory.autoAccept: commit → memory table, audit
     - else: send inline Telegram buttons [✅ Add] [❌ Dismiss]
  → button callback (telegram/handlers/memory-callbacks.ts) commits + audits
```

## Data flow 3 — scheduler fire

```
node-cron tick (scheduler/engine.ts)
  → reload schedule row (in case it was disabled in last second)
  → per-schedule budget reset if new day
  → loop-rate check (>5 runs/5min → auto-disable + principal DM)
  → consecutive-fail check (≥3 → auto-disable)
  → global budget gate (for spending kinds: bash/http-check/agent-task)
  → dispatch to handler:
      bash       → spawn /bin/sh -c payload.command, capture stdout/stderr
      http-check → fetch(payload.url), check expectedStatus
      agent-task → queue.submit with same per-chat queue as DMs
      reminder   → Telegram sendMessage, free (no Claude)
  → if handler stdout/body matches {"trigger": true, "prompt": "..."} → chain agent session
  → record schedule_runs row (status, output, tokens_used)
  → increment per-schedule budget_used_today
  → if recurring=0: delete the row (one-shot done)
```

## Data flow 4 — secret injection into skill subprocess

```
Config + .env loaded at boot
  → envSecretsStore wraps process.env
  → createSecretsManager uses:
       liveSkillPermissions(() => registry.requiredSecretsTable())
       → re-reads registry on every getSecret() call
         (so SIGHUP-added skills can resolve secrets without restart)
  → session startup (agent/session.ts):
       for each active skill:
         for each secret in skill.requiredSecrets:
           resolveSkillSecret(skill.name, secretName)
             (throws SecretScopeViolationError + writes audit if secret
              not in that skill's manifest)
           → merge into extraEnv
       runClaude env = buildClaudeEnv(process.env)  // strips ANTHROPIC_API_KEY et al
                     + extraEnv                      // scoped skill secrets only
```

## Source tree map

| Dir | What lives here |
|---|---|
| `src/agent/` | runner, session, queue, context (system-prompt), runtime-context (binding), budget, credentials, dispatch, rate-limit-tracker |
| `src/telegram/` | grammy bot, auth allowlist, streaming edit batcher, DM/command/memory handlers |
| `src/scheduler/` | engine + 4 kind handlers + Zod payload schemas + Telegram output sink |
| `src/skills/` | manifest (Zod), loader, DB-backed registry, install-script runner, MCP config composer |
| `src/policies/` | policies.json schema, load/save, layered resolver, first-boot auto-generation |
| `src/memory/` | scope-aware manager, TTL cron, post-session proposal dispatcher |
| `src/mcp/` | stdio MCP server for `memory_propose` tool |
| `src/dashboard/` | Fastify server, route modules, WebSocket log broadcaster |
| `src/db/` | `openDatabase` (WAL, FK, chmod 0600), 9 migrations, repositories |
| `src/config/` | YAML loader, Zod schema, paths, SIGHUP reload controller, secrets manager, `.env` writer |
| `src/observability/` | pino logger with redaction, heartbeat cron, error reporter, workspace sweeper |
| `src/cli/` | `andybioticlaw` admin CLI (Commander), `init` wizard, skill-setup wizard, `doctor`, `policy`, `agent` subcommands |
| `web/` | Vite + React 19 frontend (Overview, Sessions, Schedules, Memory, Notes, Skills, Logs, Config, Audit) |

## Agents, contexts, and policies

Three coordinated layers control "who is Emma running for, and what
can she do?". Inspired by OpenClaw's `agents.list` + `bindings` +
`exec-approvals.json` model, adapted to our Telegram-first single-
host shape.

```
┌─ Layer 1: Agent registry  ─────────────────────────────────────┐
│ config.yaml `agents:` block — one entry per agent.              │
│ Each agent has: id, name, default flag, model, haikuModel,     │
│   skills allowlist, optional tokenEnvVar / systemPromptFile /  │
│   workspace.                                                    │
│ Today's default install ships ONE agent ('emma'). The schema    │
│ supports N; adding a second is a config edit + restart.         │
│ During the deprecation window, the legacy single-`agent:` block │
│ is auto-synthesized into `agents: [{ id: 'emma', ... }]`.       │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─ Layer 2: Routing  (`bindings`) ───────────────────────────────┐
│ config.yaml `bindings:` array — `{ agentId, match: { channel, │
│   chatIds?, userIds? } }`. Resolver picks the FIRST match by    │
│   specificity: chat+user > chat > user > channel-only > default │
│   agent. See src/agent/runtime-context.ts.                      │
│ Output is a `RuntimeContext = { agentId, channel, chatId }`.    │
│ Serialized as `<agent>:<channel>:<chat>` and stored on every    │
│ session row + scheduled-task row.                               │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─ Layer 3: Policy lookup  (`data/policies.json`) ───────────────┐
│ Per-context settings keyed by RuntimeContext key. Each entry    │
│ may declare:                                                    │
│   - scheduleKinds       → which kinds this context may create   │
│   - scheduleAgentTaskCap→ max active agent-task schedules       │
│   - execMode            → 'deny' | 'allowlist' | 'full'         │
│   - execAllow           → Bash() patterns when mode=allowlist   │
│   - skillsVisible       → ['*'] = all enabled, or explicit list │
│   - deliverToChatId     → optional override for scheduled output│
│   - _inherits           → one-level inheritance from another    │
│                           context (no chains)                   │
│ Resolver layers: explicit context → _inherits parent → file     │
│ defaults → HARDCODED_FALLBACK (deny-by-default floor).          │
│ Auto-generated on first boot from the principal id with         │
│ `execMode: 'full'` (mirrors today's bypassPermissions); operator│
│ tightens via dashboard or by editing the file.                  │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─ Layer 4 (planned): Per-session .claude/settings.json ─────────┐
│ The harness will switch Claude CLI's `--permission-mode` from   │
│ `bypassPermissions` to `default`, write a per-session settings  │
│ file containing the resolved policy's execAllow + every active  │
│ skill's `exec_allow` block, and pass it via `--settings`. Until │
│ that ships, the policy file is informational — Claude still     │
│ runs in bypass mode.                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Adding a second agent** (e.g. work-Emma in a separate group):

1. Append a second entry to `agents:` with its own `id`, `name`,
   `tokenEnvVar`, `skills: [...]`, optional `workspace`.
2. Add a binding rule directing the relevant chat or user id to it:
   `{ agentId: 'work-emma', match: { channel: 'telegram', chatIds: [-100123] } }`.
3. Add a policy entry under `data/policies.json`'s `contexts` keyed by
   `work-emma:telegram:-100123` with the appropriate restrictions.
4. Set `TELEGRAM_BOT_TOKEN_WORK_EMMA` in `.env`.
5. Restart.

No code change. The harness wires up an additional grammy listener,
threads the agentId through every session, and looks up policies by
context key. Skills, memory, schedules, and the audit log all gain
a per-agent dimension automatically.

## Key invariants

These are the contracts the system enforces at runtime; violating them
is either a bug or a security regression.

1. **No API-key billing.** The `claude` subprocess is spawned with an
   env stripped of `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
   `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`. If its
   `system/init` event reports `apiKeySource` other than `"none"`, we
   SIGKILL it. See `docs/SECURITY.md` § Enforcement layers.
2. **Secret scoping.** A skill can only read secrets declared in its
   `manifest.yaml`. Violations throw `SecretScopeViolationError` and
   write a `secret_scope_violation` audit row.
3. **Per-chat serialization.** Two messages from the same chat never
   run concurrently. Different chats run in parallel.
4. **Schedule loop protection.** 3 consecutive failures OR >5 runs in
   5 minutes → auto-disable + principal DM.
5. **Agent can't create shell schedules.** Only `--reminder` and
   `--message` (= reminder + agent-task) unless
   `ANDYBIOTICLAW_AGENT_CAN_BASH=1` is set by the caller. Every
   agent-initiated schedule is audited (`schedule_created_by_agent`).
   Capped at `AGENT_TASK_SCHEDULE_CAP=20` active rows total.
6. **Migration-only column changes.** `agent_id` and `context` were
   added by migration 0009 with safe defaults; existing rows
   backfilled silently. No column drops, no rename — DB downgrade by
   tarball restore is always possible.

## Further reading

- **Why** each of these shapes is what it is → `README.md` § Design decisions.
- **What the trust boundary looks like in practice** → `docs/SECURITY.md`.
- **How to deploy this end-to-end** → `docs/QUICKSTART.md` (laptop / fast VPS) or `docs/DEPLOYMENT.md` (full Hetzner Ubuntu).
- **How to author a skill** → `skills/README.md`.
