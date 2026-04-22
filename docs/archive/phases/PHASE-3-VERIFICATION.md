# Phase 3 — manual verification checklist

Covers the Phase 3 done-criteria:
- Memory CRUD via CLI AND Telegram.
- A test skill is registered correctly by the loader.
- Secret-scoping unit test (Skill A cannot read Skill B's secret) passes.

Prerequisites as in Phase 2 (working `claude` CLI with subscription, Telegram
bot token set, your user id in `telegram.dm.allowedUserIds`).

## 1. Migration 0002 applied

```bash
pnpm build
rm -f data/andybioticlaw.db*
NODE_ENV=production node dist/index.js &
sleep 2
kill -TERM %1
wait

sqlite3 data/andybioticlaw.db "SELECT version FROM schema_version;"
# 1
# 2

sqlite3 data/andybioticlaw.db ".tables"
# audit              memory_proposals   schedule_runs      sessions
# heartbeats         messages           schedules          skill_state
# memory             schema_version
```

## 2. Memory CRUD via CLI

```bash
pnpm exec tsx src/cli/admin.ts memory add global "user prefers Swiss German"
pnpm exec tsx src/cli/admin.ts memory add user:18998064 "lives in Zurich" --key pref/location --ttl 3600
pnpm exec tsx src/cli/admin.ts memory list
pnpm exec tsx src/cli/admin.ts memory list --scope global
pnpm exec tsx src/cli/admin.ts memory show 1
pnpm exec tsx src/cli/admin.ts memory remove 1
pnpm exec tsx src/cli/admin.ts memory add 'has spaces' foo  # rejected
```

Expected:
- Add prints `added #<id>  <scope>`.
- List columns: `#id  scope [key]  source  updated=<ts>  ttl=<ts?>` + value on the next line.
- Show prints the JSON row.
- Remove prints `removed #<id>`.
- Bad scope prints `FAIL — scope "has spaces" is malformed — …`.

## 3. Memory CRUD via Telegram

```
/remember user prefers strong coffee
/remember @global Emma should answer in Swiss German by default
/remember @chat this chat is for scratch thinking
/memory
/forget 1
```

Expected:
- First `/remember` stores under `user:<your-tg-id>`.
- `@global`, `@chat`, `@user` prefixes route correctly.
- `/memory` shows active snapshot grouped by scope, with ttl hints.
- `/forget <id>` confirms removal; `/forget <unknown>` says "no memory entry with id N".

## 4. Agent proposes memory via MCP; user accepts/dismisses

Send **"I always work from a CET timezone — remember that."**

- During the session, the agent calls `mcp__andybioticlaw-memory__memory_propose` (visible as a tool_use in the verbose log if `--log-level debug`).
- After the final response, the bot sends a second message:
  ```
  🧠 Propose memory
  Scope: `global` (or similar)
  _user works from CET timezone_
  [✅ Add]  [❌ Dismiss]
  ```
- Click ✅ → message is edited to `🧠 Added to memory (scope: global).`; the entry shows up in `memory list`.
- Send another proposal-worthy message, click ❌ → message is edited to `🙅 Dismissed — nothing stored.`; no entry is added.
- Audit rows record the action:
  ```bash
  sqlite3 data/andybioticlaw.db "SELECT kind, detail FROM audit WHERE kind LIKE 'memory_proposal%' ORDER BY at DESC LIMIT 5;"
  ```

## 5. Memory is scope-aware in the next turn

After accepting the proposal from step 4, send a follow-up like **"What do you know about my timezone?"**. The reply should reference the accepted memory without needing a reminder. The system prompt's `## Active memory` block should include the entry — verify by briefly raising `service.logLevel` to `debug` and looking at a single session's spawn log.

## 6. Skill loader registers a skill

Create a test skill:

```bash
mkdir -p skills/demo
cat > skills/demo/manifest.yaml <<'EOF'
name: demo
version: 0.1.0
description: Demo skill for Phase 3 verification.
enabled: true
scope:
  - dm
required_secrets: []
EOF

cat > skills/demo/SKILL.md <<'EOF'
# demo skill
Instructs Emma to greet the user with an emoji once per session.
EOF
```

```bash
pnpm exec tsx src/cli/admin.ts skill list
# ✓  demo@0.1.0  [dm]  Demo skill for Phase 3 verification.

pnpm exec tsx src/cli/admin.ts skill show demo
# JSON dump of the SkillRecord

pnpm exec tsx src/cli/admin.ts skill disable demo
pnpm exec tsx src/cli/admin.ts skill list
# ✗  demo@0.1.0  [dm]  Demo skill for Phase 3 verification.

pnpm exec tsx src/cli/admin.ts skill enable demo
```

Start the service and send a message. The SKILL.md content should appear in
the per-session system prompt (visible under `debug` log level), and the
generated `.mcp.json` lives at `data/workspaces/dm/<session-id>/.mcp.json` —
inspect it briefly to confirm it contains the `andybioticlaw-memory` server.

Remove the test skill:

```bash
rm -rf skills/demo
```

## 7. Bad manifest is non-fatal

```bash
mkdir -p skills/bad
cat > skills/bad/manifest.yaml <<'EOF'
name: wrong-name
version: bad-semver
description: ""
enabled: true
scope: []
EOF
cat > skills/bad/SKILL.md <<'EOF'
# bad
EOF
```

Run `pnpm exec tsx src/cli/admin.ts skill list`. Output should show `demo`
(if still present) and the service log should contain a `skill manifest invalid`
error listing all violations (name mismatch, bad semver, empty description,
empty scope) — but the service keeps running.

Clean up: `rm -rf skills/bad`.

## 8. Scoped secret injection (Phase 3 done-criterion)

The unit test `tests/unit/skills-scoping.test.ts` exercises this end-to-end
against the real manifest loader + registry + secrets manager. Run:

```bash
pnpm test -- skills-scoping
```

Expected:
- `skill A reads only its own declared secret; reading B throws and audits` — passes.
- `core scope cannot read any skill secret` — passes.

## 9. Memory TTL cleanup

```bash
pnpm exec tsx src/cli/admin.ts memory add global "short-lived" --ttl 2
sleep 3
pnpm exec tsx src/cli/admin.ts memory list
# entry is still there (cron hasn't run yet)
```

Memory reads (e.g. via `/memory` or in-session snapshot) already FILTER OUT
expired rows — even before the cron physically deletes them. The cron itself
runs at `memory.ttlCleanupCron` (default `0 3 * * *`) in the service timezone
and permanently removes expired rows from the table.

## 10. Full E2E against real Claude CLI

```bash
CLAUDE_E2E=1 pnpm test tests/integration/runner.e2e.test.ts
```

Expected: all three tests pass, including the "agent can queue a memory
proposal via the memory-proposal MCP tool" case. The third test specifically
proves the claude CLI spawned our MCP server, called its tool, and the
proposal landed in the DB.
