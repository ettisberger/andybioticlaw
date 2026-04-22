#!/usr/bin/env bash
# andybioticlaw — production installer (Debian/Ubuntu).
#
# Assumes you've already rsynced the source tree into $INSTALL_DIR on
# the target host. This script handles:
#   1. Pre-flight checks (root, supported OS, required binaries)
#   2. System user + home dir
#   3. Install-dir ownership + permissions
#   4. Production dependency install (native modules compiled for THIS arch)
#   5. systemd unit installation (main service + backup service + timer)
#   6. logrotate config
#   7. Next-step guidance (claude login, config.yaml, .env, start)
#
# Usage (on the target host):
#   sudo bash scripts/install.sh
#
# Idempotent — re-running is safe.

set -euo pipefail

SERVICE_USER="andybioticlaw"
SERVICE_GROUP="andybioticlaw"
INSTALL_DIR="${ANDYBIOTICLAW_INSTALL_DIR:-/opt/andybioticlaw}"
SYSTEMD_DIR="/etc/systemd/system"
LOGROTATE_FILE="/etc/logrotate.d/andybioticlaw"
HOME_DIR="/home/$SERVICE_USER"

# ---------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found — this installer targets systemd-based distros (Debian/Ubuntu)" >&2
  exit 1
fi

for bin in node sqlite3 logrotate; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "required binary not found: $bin" >&2
    echo "  install with:  apt-get install -y nodejs sqlite3 logrotate" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "node $NODE_MAJOR is too old — need 20 LTS or newer" >&2
  exit 1
fi

if ! command -v corepack >/dev/null 2>&1; then
  echo "corepack not found — needed for pnpm. install node with corepack bundled, or run:" >&2
  echo "  npm i -g corepack" >&2
  exit 1
fi
corepack enable pnpm >/dev/null 2>&1 || true

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "no install dir at $INSTALL_DIR — rsync the source tree here first" >&2
  exit 1
fi
if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  echo "no package.json in $INSTALL_DIR — is this really the andybioticlaw tree?" >&2
  exit 1
fi

echo "✓ pre-flight OK (node $(node -v), sqlite3 $(sqlite3 -version | awk '{print $1}'))"

# ---------------------------------------------------------------------------
# 2. System user
# ---------------------------------------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /bin/bash "$SERVICE_USER"
  echo "✓ created system user $SERVICE_USER (home=$HOME_DIR)"
else
  echo "✓ user $SERVICE_USER already exists"
fi

# ---------------------------------------------------------------------------
# 3. Install-dir ownership + permissions
# ---------------------------------------------------------------------------
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
# data/ should be writable for the service; everything else is read-traversable.
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/data/logs" "$INSTALL_DIR/data/backups" "$INSTALL_DIR/data/workspaces"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data"
echo "✓ ownership + permissions set"

# ---------------------------------------------------------------------------
# 4. Production deps (native modules compiled for THIS host's arch)
# ---------------------------------------------------------------------------
echo "installing production dependencies under $INSTALL_DIR (this compiles better-sqlite3 + argon2 natively for this host)…"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && pnpm install --prod --frozen-lockfile"
echo "✓ deps installed"

if [[ ! -f "$INSTALL_DIR/dist/index.js" ]]; then
  echo "WARNING: $INSTALL_DIR/dist/index.js not found — did you forget to rsync the built backend?" >&2
  echo "  on your dev machine:  pnpm build && rsync -a dist/ \$HOST:$INSTALL_DIR/dist/" >&2
fi
if [[ ! -f "$INSTALL_DIR/web/dist/index.html" ]]; then
  echo "WARNING: $INSTALL_DIR/web/dist/index.html not found — dashboard UI will show placeholder" >&2
  echo "  on your dev machine:  pnpm --filter @andybioticlaw/web build && rsync -a web/dist/ \$HOST:$INSTALL_DIR/web/dist/" >&2
fi

# ---------------------------------------------------------------------------
# 5. systemd units (main service + backup service + timer)
# ---------------------------------------------------------------------------
for unit in andybioticlaw.service andybioticlaw-backup.service andybioticlaw-backup.timer; do
  src="$INSTALL_DIR/systemd/$unit"
  if [[ -f "$src" ]]; then
    install -m 0644 "$src" "$SYSTEMD_DIR/$unit"
    echo "✓ installed $unit"
  else
    echo "skip missing $src" >&2
  fi
done
systemctl daemon-reload
systemctl enable andybioticlaw.service          >/dev/null
systemctl enable --now andybioticlaw-backup.timer >/dev/null
echo "✓ systemd units enabled (main service NOT started yet — see next steps)"

# ---------------------------------------------------------------------------
# 6. logrotate
# ---------------------------------------------------------------------------
if [[ -f "$INSTALL_DIR/systemd/andybioticlaw.logrotate" ]]; then
  install -m 0644 "$INSTALL_DIR/systemd/andybioticlaw.logrotate" "$LOGROTATE_FILE"
  # Validate
  if logrotate -d "$LOGROTATE_FILE" >/dev/null 2>&1; then
    echo "✓ logrotate config installed at $LOGROTATE_FILE"
  else
    echo "WARNING: logrotate -d reported errors — check $LOGROTATE_FILE" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 7. Next steps
# ---------------------------------------------------------------------------
cat <<EOF

=========================================================================
andybioticlaw installed at $INSTALL_DIR

Remaining steps (one-time):

  1. Log the service user into Claude so its subscription is available:
       sudo -u $SERVICE_USER -H bash -lc 'claude login'
     (OAuth flow — open the URL it prints, paste the code back.)

  2. Populate config + secrets as the service user:
       sudo -u $SERVICE_USER $EDITOR $INSTALL_DIR/config/config.yaml
       sudo -u $SERVICE_USER $EDITOR $INSTALL_DIR/.env
     Validate:
       sudo -u $SERVICE_USER -H bash -lc 'cd $INSTALL_DIR && node dist/cli/admin.js config validate'

  3. Start the service:
       systemctl start andybioticlaw
       systemctl status andybioticlaw

  4. Follow logs:
       journalctl -u andybioticlaw -f
     or:
       tail -f $INSTALL_DIR/data/logs/andybioticlaw.log

  5. (Optional) Expose the dashboard. Default is 127.0.0.1:18790.
     See docs/DEPLOYMENT.md for reverse-proxy + basic-auth guidance.

Backups run daily at ~03:15 local (andybioticlaw-backup.timer). Verify:
  systemctl list-timers andybioticlaw-backup.timer
=========================================================================
EOF
