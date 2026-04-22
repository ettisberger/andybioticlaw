# Phase 1 — manual verification checklist

Run the steps below after a fresh clone to confirm Phase 1 done-criteria. Each
bullet lists the expected outcome; anything else is a regression.

Prerequisites: Node ≥ 20, pnpm (via `corepack enable pnpm` if needed), and a
working `claude` CLI with a logged-in subscription. (On macOS, the credential
is stored in the Keychain — you won't see a file under `~/.claude/`.)

## 1. Install and scaffolding

```bash
./scripts/bootstrap-dev.sh
```

Expected:
- `pnpm install` completes without errors.
- `config/config.yaml` and `.env` are created from the examples.
- The final `config validate` prints `OK — config valid: …`.

## 2. Config validation — happy and failure paths

```bash
pnpm exec tsx src/cli/admin.ts config validate
```
- Exits 0, prints agent/model/dataDir.

```bash
pnpm exec tsx src/cli/admin.ts config validate -c /tmp/missing.yaml
```
- Exits 2, prints `FAIL — file-missing` with a copy-from-example hint.

```bash
cp config/config.yaml /tmp/bad.yaml && sed -i.bak 's/claude-opus-4-7/gpt-4o/' /tmp/bad.yaml
pnpm exec tsx src/cli/admin.ts config validate -c /tmp/bad.yaml
```
- Exits 2, prints `FAIL — validation` with `agent.model: model must be a valid Claude model ID…`.

## 3. TypeScript, tests, lint

```bash
pnpm typecheck   # no output
pnpm test        # 2 files, 9 tests pass (config + secrets)
pnpm build       # creates dist/ with migrations .sql + prompts .md copied in
```

## 4. Service boot (dev)

```bash
pnpm dev
```
- Logs (pretty-printed) in order:
  - `andybioticlaw starting (agent: Emma, model: claude-opus-4-7)`
  - `applied migration { file: '0001_init.sql', version: 1 }`
  - `claude credentials OK` (method: claude-auth-status)
  - `0 skills loaded`
  - `ready`
- `data/andybioticlaw.db` exists with tables `sessions`, `messages`, `memory`,
  `schedules`, `schedule_runs`, `heartbeats`, `audit`, `schema_version`.
- `data/andybioticlaw.pid` exists with the current PID.
- A row is written to `heartbeats` at startup, then every 60 s.

## 5. Service boot (prod build)

```bash
rm -rf data/andybioticlaw.db* data/andybioticlaw.pid data/logs/andybioticlaw.log
pnpm build
NODE_ENV=production node dist/index.js &
sleep 2
cat data/logs/andybioticlaw.log | head    # JSON lines, no pretty-printing
cat data/andybioticlaw.pid
```
- JSON-line logs with `svc: andybioticlaw`.
- Same lifecycle lines as dev.
- PID file is 0600 and points at the running process.

## 6. SIGHUP reload — both code paths

Leave the process from step 5 running.

**Hot-reloadable field:**

```bash
sed -i.bak 's/heartbeatIntervalSec: 60/heartbeatIntervalSec: 45/' config/config.yaml
pnpm exec tsx src/cli/admin.ts config reload
tail -5 data/logs/andybioticlaw.log
```

- Logs contain `received SIGHUP — reloading config` and
  `config reload: 1 field(s) hot-reloaded` with `fields: [observability.heartbeatIntervalSec]`.

**Restart-required field:**

```bash
sed -i.bak 's/model: claude-opus-4-7/model: claude-sonnet-4-6/' config/config.yaml
pnpm exec tsx src/cli/admin.ts config reload
tail -5 data/logs/andybioticlaw.log
```

- Logs contain `field agent.model changed but requires restart — keeping old value`
  with `was: claude-opus-4-7, now: claude-sonnet-4-6`.

Restore the config afterwards.

## 7. Graceful shutdown

```bash
kill -TERM <pid>
```
- Logs `shutting down` with `signal: SIGTERM`.
- `data/andybioticlaw.pid` is removed.
- Exit code 0.

## 8. Orphan sweep on next boot

If the process was killed with `SIGKILL` (simulating a crash), the next boot
should log a warning with a count of sessions transitioned to `orphaned`. In
Phase 1 there are no sessions, so this line won't appear — the code path is
exercised in Phase 2's verification.

## 9. Credentials-check failure is non-fatal

Temporarily point the credentials dir at a dead path:

```bash
cp config/config.yaml /tmp/cfg-save.yaml
sed -i.bak 's@~/.claude@/nonexistent-for-test@' config/config.yaml
# Also temporarily hide `claude` from PATH in a subshell:
PATH=/usr/bin:/bin pnpm dev
```
- Logs `ERROR: claude credentials unavailable …` with a `reason` and a `hint`.
- An `audit` row of kind `credentials_missing` is written.
- Service still logs `ready` and stays up.

Restore with `mv /tmp/cfg-save.yaml config/config.yaml`.

## 10. Redaction

Any log line that includes a field matching `*.token`, `*.password`, `*.secret`,
`*.api_key` etc. should show `[REDACTED]` in the log. Quick check:

```bash
node -e '
import("./dist/observability/logger.js").then(({buildLogger}) => {
  const log = buildLogger({level:"info", logsDir:"/tmp", pretty:true});
  log.info({token:"ABC", nested:{password:"xyz"}, safe:"ok"}, "redact-check");
});
'
```
- Output shows `token: "[REDACTED]"`, `password: "[REDACTED]"`, `safe: "ok"`.
