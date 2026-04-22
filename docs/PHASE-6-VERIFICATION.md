# Phase 6 — manual verification checklist

Covers the Phase 6 deliverables:
- Backup script with rotation.
- `install.sh` complete (user / permissions / systemd / logrotate).
- Integration tests for critical flows.
- Deployment doc with `claude login` step.

## 1. Backup script — happy path

```bash
./scripts/backup.sh
# expect:
#   backup written: /.../data/backups/andybioticlaw-YYYYMMDDTHHMMSSZ.db
#   1 backup(s) retained in /.../data/backups

ls data/backups/
# shows the new file
```

Integrity check ran automatically (fails loudly if the copy is corrupt).

## 2. Backup rotation — prune older files

```bash
# Create a fake "old" backup (8 days ago) and re-run.
touch -t $(date -v-8d +%Y%m%d%H%M) data/backups/andybioticlaw-20260101T000000Z.db  # macOS
#   or:
# touch -d '8 days ago' data/backups/andybioticlaw-20260101T000000Z.db            # linux

./scripts/backup.sh
# "andybioticlaw-20260101T000000Z.db" should have been pruned.

ls data/backups/
```

Override the retention window for ad-hoc runs:

```bash
ANDYBIOTICLAW_BACKUP_RETENTION_DAYS=1 ./scripts/backup.sh
```

## 3. Systemd backup timer (Linux deployment)

```bash
# On the VPS after install.sh
sudo systemctl status andybioticlaw-backup.timer
sudo systemctl list-timers andybioticlaw-backup.timer
# expect next firing around 03:15 local

# Force a run right now:
sudo systemctl start andybioticlaw-backup.service
sudo journalctl -u andybioticlaw-backup.service -n 20
# "backup written: …" + retention count
```

## 4. install.sh idempotency

On a fresh VPS:

```bash
sudo bash /opt/andybioticlaw/scripts/install.sh
# creates user, deps, systemd units, logrotate

sudo bash /opt/andybioticlaw/scripts/install.sh
# re-running is a no-op (user already exists, deps already installed,
# units already installed). Output should show all "✓" lines with no
# errors.
```

## 5. logrotate dry-run

```bash
sudo logrotate -d /etc/logrotate.d/andybioticlaw
# should print a plan without rotating (dry-run mode)

# Force a rotation manually (creates .1, .2.gz, etc.):
sudo logrotate -f /etc/logrotate.d/andybioticlaw
ls /opt/andybioticlaw/data/logs/
# andybioticlaw.log  andybioticlaw.log.1
```

Because our pino logger opens the file path each write, the service
continues writing into the new (fresh) `andybioticlaw.log` without any
signal or restart.

## 6. Integration tests

```bash
pnpm build
pnpm test
# expect:
#   Test Files  18 passed | 1 skipped
#   Tests       82 passed | 3 skipped
```

The integration tests that run by default:

- `tests/integration/boot-and-shutdown.test.ts` — spawns `node
  dist/index.js` in a scratch dir, verifies `/api/overview` answers,
  SIGTERMs, confirms clean exit + pidfile removal.
- `tests/integration/migrations.test.ts` — fresh DB gets both
  migrations; re-opening doesn't double-apply.
- `tests/integration/orphan-recovery.test.ts` — running/queued
  sessions get flipped to `orphaned` with error column populated and
  chat ids reported back.

Plus the live Claude E2E (still gated behind `CLAUDE_E2E=1`):

```bash
CLAUDE_E2E=1 pnpm test tests/integration/runner.e2e.test.ts
# 3 passed
```

## 7. Hetzner deployment walkthrough

Follow `docs/DEPLOYMENT.md` end-to-end on a fresh VPS. The checklist
ends with:
- bot responds to a DM from your account,
- `journalctl -u andybioticlaw -f` is flowing,
- `systemctl list-timers` shows the backup timer,
- dashboard reachable via SSH tunnel.

## 8. Graceful shutdown under load

Start a long session (Telegram `write me a 2000-word story`) and trigger a
restart:

```bash
sudo systemctl restart andybioticlaw
```

Expected:

- Log: `shutting down (signal: SIGTERM)`.
- Session streams to completion within the 30s grace window, if possible.
- If the session is mid-stream at the 30s mark: left in `running`,
  which the next boot's orphan sweep flips to `orphaned` with the
  aggregated admin DM (Phase 2 behavior, verified here).

## 9. Session retry from dashboard survives restart

Produce a failed session (any path). Restart the service. Open the
dashboard — click `retry` on that session. New session runs to
completion via the existing queue.
