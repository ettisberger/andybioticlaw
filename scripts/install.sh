#!/usr/bin/env bash
# andybioticlaw — production install skeleton (Hetzner, Ubuntu 24.04).
#
# This is the Phase 1 SKELETON. Full, battle-tested install.sh lands in
# Phase 6. Treat the steps below as a checklist for a human operator, not
# an unattended deploy script — run line-by-line on a fresh VPS and adjust.
#
# Usage:
#   sudo bash scripts/install.sh
#
set -euo pipefail

SERVICE_USER="andybioticlaw"
INSTALL_DIR="/opt/andybioticlaw"
SYSTEMD_UNIT="/etc/systemd/system/andybioticlaw.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

# 1. Create service user with its own home so `claude login` writes a
#    credential store for the service (not for your admin account).
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /bin/bash "$SERVICE_USER"
fi

# 2. Install directory + data directory (sticky perms to protect SQLite file).
mkdir -p "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"

# 3. TODO (operator): copy the built `dist/` + `node_modules/` + `config/` +
#    `skills/` + `systemd/` into $INSTALL_DIR. Recommended: build on a
#    separate CI host and rsync the artifacts over, or use a tarball release.

# 4. Install systemd unit.
if [[ -f "$INSTALL_DIR/systemd/andybioticlaw.service" ]]; then
  install -m 0644 "$INSTALL_DIR/systemd/andybioticlaw.service" "$SYSTEMD_UNIT"
  systemctl daemon-reload
  systemctl enable andybioticlaw
  echo "systemd unit installed — start with: systemctl start andybioticlaw"
else
  echo "WARNING: $INSTALL_DIR/systemd/andybioticlaw.service not found; skipping" >&2
fi

# 5. TODO (operator, Phase 6): logrotate config.
#    Target: /etc/logrotate.d/andybioticlaw — rotate data/logs/*.log daily,
#    retain 14 days, compress, delaycompress, postrotate sends USR1 to pino
#    if we add reopen support (not required in v1).

# 6. TODO (operator): switch to $SERVICE_USER and run `claude login` so
#    ~/.claude is populated for the service before first start:
#       sudo -u $SERVICE_USER -H bash -lc 'claude login'

echo "done — remaining manual steps:"
echo "  1. sudo -u $SERVICE_USER -H bash -lc 'claude login'"
echo "  2. populate $INSTALL_DIR/config/config.yaml and $INSTALL_DIR/.env"
echo "  3. systemctl start andybioticlaw && systemctl status andybioticlaw"
