#!/usr/bin/env bash
# andybioticlaw — SQLite online backup with 7-day rotation.
#
# Uses sqlite3's `.backup` command (online — safe against a live writer
# because of WAL mode). Drops the new artifact in data/backups/ with a
# UTC timestamp in the filename, then prunes anything older than
# $RETENTION_DAYS (default 7).
#
# Safe to invoke on a running service. Intended to be driven by
# systemd/andybioticlaw-backup.timer (daily) in production; fine to
# run ad-hoc during dev.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$ROOT/data/andybioticlaw.db"
OUT_DIR="$ROOT/data/backups"
RETENTION_DAYS="${ANDYBIOTICLAW_BACKUP_RETENTION_DAYS:-7}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/andybioticlaw-$TS.db"

if [[ ! -f "$DB" ]]; then
  echo "no database at $DB — nothing to back up" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Online backup. WAL mode + .backup is crash-consistent without needing the
# service to be paused. If sqlite3 isn't installed, fall back to a raw copy
# of the main DB file (best effort — may miss in-flight WAL pages).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$OUT'"
else
  echo "WARN: sqlite3 CLI not found; falling back to raw file copy" >&2
  cp "$DB" "$OUT"
fi

# Quick integrity sanity check before we consider this backup real.
if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
    echo "ERROR: integrity check failed on $OUT — keeping the file for inspection" >&2
    exit 2
  fi
fi

echo "backup written: $OUT"

# Prune older backups.
find "$OUT_DIR" -maxdepth 1 -name 'andybioticlaw-*.db' -type f -mtime "+$RETENTION_DAYS" -delete
find "$OUT_DIR" -maxdepth 1 -name 'andybioticlaw-*.db' -type f -mtime "+$RETENTION_DAYS" \
  | while read -r f; do
      echo "pruned old backup: $f"
    done

# Report what remains (for the timer's journal).
count="$(find "$OUT_DIR" -maxdepth 1 -name 'andybioticlaw-*.db' -type f | wc -l | tr -d ' ')"
echo "$count backup(s) retained in $OUT_DIR"
