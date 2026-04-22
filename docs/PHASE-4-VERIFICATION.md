# Phase 4 — manual verification checklist

Covers the Phase 4 done-criteria:
- A `bash` schedule triggers an `agent-task` only when stdout contains
  `{"trigger": true, ...}`.
- A schedule that fails 3 times in a row is auto-disabled.
- A schedule that busts its per-day token budget is disabled and an alert
  is sent.

Prerequisites: Phase 3 passing, service running, Telegram bot token set.

## 1. CRUD round-trip

```bash
pnpm exec tsx src/cli/admin.ts schedule list
# (no schedules defined)

pnpm exec tsx src/cli/admin.ts schedule add \
  --name "ping" \
  --cron "* * * * *" \
  --kind reminder \
  --payload '{"text":"⏰ minute tick"}'
# created #1 ping [reminder] ... + SIGHUP sent

pnpm exec tsx src/cli/admin.ts schedule list
# ✓ #1 ping [reminder] cron='* * * * *'
```

Wait ~65s. You should receive `⏰ minute tick` in Telegram. Then:

```bash
pnpm exec tsx src/cli/admin.ts schedule show 1 --limit 5
# shows the JSON row + last N runs

pnpm exec tsx src/cli/admin.ts schedule disable 1
# disabled #1

# verify the engine stops firing — no more telegram messages within 2 minutes.
```

## 2. Bash: no trigger → no agent session

```bash
pnpm exec tsx src/cli/admin.ts schedule add \
  --name "bash-passive" \
  --cron "* * * * *" \
  --kind bash \
  --payload '{"command":"echo hello from bash"}'
```

Wait ~65s.

- No Telegram message (reminder-style; `bash` alone is silent).
- `sqlite3 data/andybioticlaw.db "SELECT status, tokens_used, output FROM schedule_runs WHERE schedule_id=<id> ORDER BY started_at DESC LIMIT 1;"`
  → `success | 0 | hello from bash`

## 3. Bash → trigger → agent-task (THE PHASE 4 DONE-CRITERION)

```bash
pnpm exec tsx src/cli/admin.ts schedule add \
  --name "bash-trigger-demo" \
  --cron "* * * * *" \
  --kind bash \
  --budget 50000 \
  --payload '{"command":"echo ''\\''{\"trigger\": true, \"prompt\": \"In one sentence: what is the current time?\"}''\\''"}'
```

(Note the quoting — bash payload must itself be valid JSON; the `command`
field's content uses escaped shell quoting to emit a JSON object on stdout.)

Wait ~65s.

- You should receive ONE Telegram message labeled `📅 bash-trigger-demo` with
  Emma's answer (e.g. "The current time is …").
- `schedule_runs` shows `status=success, tokens_used > 0, output` like
  `bash OK → agent OK (N tokens). stdout head: …`.
- `schedule list` shows `budget=N/50000`.

Disable when done:

```bash
pnpm exec tsx src/cli/admin.ts schedule disable <id>
```

## 4. Auto-disable after 3 consecutive fails

```bash
pnpm exec tsx src/cli/admin.ts schedule add \
  --name "always-fails" \
  --cron "* * * * *" \
  --kind bash \
  --payload '{"command":"exit 1"}'
```

Wait ~3.5 minutes.

- Telegram alert after the 3rd fail: `⚠️ Schedule 'always-fails' auto-disabled: 3 consecutive failures`.
- `schedule list` shows `✗` for that row, `fails=3`.
- Audit row:
  ```bash
  sqlite3 data/andybioticlaw.db "SELECT kind, detail FROM audit WHERE kind='schedule_auto_disabled' ORDER BY at DESC LIMIT 1;"
  ```

Clean up:

```bash
pnpm exec tsx src/cli/admin.ts schedule remove <id>
```

## 5. Auto-disable from loop-rate (>5 runs in 5 minutes)

A 1-min cron hits 5 runs in ~5 minutes. To trigger the loop-rate guard,
you'd need a schedule that somehow fires faster than its cron — which
this engine doesn't allow for a single schedule. The loop-rate check is a
defense-in-depth against clock-skew / DST anomalies; see
`tests/unit/scheduler-engine.test.ts` `countRunsSince` for the unit-level
proof.

## 6. Per-schedule budget exhaustion alert

```bash
pnpm exec tsx src/cli/admin.ts schedule add \
  --name "tiny-budget" \
  --cron "* * * * *" \
  --kind agent-task \
  --budget 100 \
  --payload '{"prompt":"write a 200-word essay"}'
```

After the first fire (which will use several thousand tokens, way over 100):

- Telegram alert: `⚠️ Schedule 'tiny-budget' hit its per-day token budget (N/100)…`.
- Audit row `schedule_budget_exhausted`:
  ```bash
  sqlite3 data/andybioticlaw.db "SELECT detail FROM audit WHERE kind='schedule_budget_exhausted' ORDER BY at DESC LIMIT 1;"
  ```
- Next firing: `schedule_runs` row with `status='skipped', output='per-schedule token budget exhausted'`.

Clean up:

```bash
pnpm exec tsx src/cli/admin.ts schedule remove <id>
```

## 7. http-check with trigger envelope

Point at any endpoint that returns a trigger envelope. For a local test,
use `python3 -m http.server` + a JSON file, or an external service under
your control. Example payload:

```json
{
  "url": "https://httpbin.org/json",
  "expectedStatus": 200
}
```

httpbin returns non-trigger JSON, so the schedule completes with
`status=success` and no chained agent session. To exercise the chain,
put a trigger envelope behind an endpoint you control.

## 8. SIGHUP picks up DB changes

```bash
# Start service, no schedules.
# Add a schedule — SIGHUP is sent automatically:
pnpm exec tsx src/cli/admin.ts schedule add --name x --cron '* * * * *' --kind reminder --payload '{"text":"y"}'
# Service log shows:  "count":1,"msg":"scheduler refreshed"
tail data/logs/andybioticlaw.log | grep 'scheduler refreshed'
# Disable — SIGHUP sent again:
pnpm exec tsx src/cli/admin.ts schedule disable 1
tail data/logs/andybioticlaw.log | grep 'scheduler refreshed'
# Refreshed count drops back to 0.
```

## 9. Graceful shutdown stops scheduler

SIGTERM the daemon. Log: `shutting down (signal: SIGTERM)`. No cron tasks
fire after shutdown begins. Confirmed also that in-flight agent sessions
get up to 30s to finish before SIGKILL (Phase 2 behavior, unchanged).
