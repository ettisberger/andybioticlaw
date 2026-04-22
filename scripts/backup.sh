#!/usr/bin/env bash
# Wraps SQLite online backup. Runs against data/andybioticlaw.db.
# Phase 6 will wrap this in a systemd timer + 7-day rotation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="$ROOT/data/andybioticlaw.db"
OUT_DIR="$ROOT/data/backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/andybioticlaw-$TS.db"

if [[ ! -f "$DB" ]]; then
  echo "no database at $DB — nothing to back up" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
sqlite3 "$DB" ".backup '$OUT'"
echo "backup written: $OUT"

# Phase 6: prune older than N days.
# find "$OUT_DIR" -name 'andybioticlaw-*.db' -mtime +7 -delete
