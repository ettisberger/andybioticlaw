#!/usr/bin/env bash
# andybioticlaw — production installer (Debian/Ubuntu).
#
# Pattern: service user `andybioticlaw` with the app tucked into
# `/home/andybioticlaw/.andybioticlaw/` (mode 0700, hidden dotdir — same
# layout convention as openclaw on Ubuntu).
#
# This script discovers its own location, creates the service user if
# needed, copies the source tree into the user's home dotdir, installs
# native prod deps as the service user, renders the systemd + logrotate
# templates with the resolved install path, and enables everything.
#
# Idempotent — re-running is safe. If the install dir already has the
# expected layout, the copy step is a no-op (rsync with --update).
# Run `sudo bash scripts/install.sh --help` for the full install recipe.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Flag parsing (before anything else; --help exits fast, no root needed)
# ---------------------------------------------------------------------------
# `GIT_REMOTE` is only used to print the documented clone URL in --help.
# Nothing in this script actually invokes git; the release-tarball install
# path doesn't need git at all. Override via `GIT_REMOTE=... bash install.sh`
# if you're running from a fork and want the help text to reflect that.
GIT_REMOTE="${GIT_REMOTE:-https://github.com/ettisberger/andybioticlaw.git}"

show_help() {
  cat <<HELP
andybioticlaw installer — copies a staged source tree into the service
user's home dotdir, installs native prod deps, and sets up systemd +
logrotate.

USAGE
  sudo bash scripts/install.sh            # normal install / re-install
  sudo bash scripts/install.sh --help     # this message

TWO INSTALL PATHS

A) Release tarball (recommended, no build toolchain needed beyond pnpm):

    mkdir -p ~/andybioticlaw && cd ~/andybioticlaw
    curl -fsSL https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz \\
      | tar xz --strip-components=1
    sudo bash scripts/install.sh

B) Git clone (for tip-of-main / contributors):

    git clone $GIT_REMOTE ~/andybioticlaw
    cd ~/andybioticlaw
    pnpm install --frozen-lockfile
    pnpm build
    pnpm --filter @andybioticlaw/web build
    sudo bash scripts/install.sh

ENVIRONMENT OVERRIDES

  ANDYBIOTICLAW_INSTALL_DIR   Install location. Default: /home/andybioticlaw/.andybioticlaw
  GIT_REMOTE                  Only used in this help text. Default: $GIT_REMOTE

AFTER INSTALL

  sudo -iu andybioticlaw
  claude login          # one-time Claude subscription OAuth
  andybioticlaw         # interactive menu → "Run setup wizard"
  exit
  sudo systemctl start andybioticlaw
  sudo journalctl -u andybioticlaw -f

See docs/DEPLOYMENT.md for the full walkthrough (firewall, backups,
dashboard reverse-proxy with TLS + basic-auth).
HELP
}

case "${1:-}" in
  -h|--help|help)
    show_help
    exit 0
    ;;
  "")
    ;;
  *)
    echo "unknown flag: $1" >&2
    echo "run with --help for usage" >&2
    exit 2
    ;;
esac

SERVICE_USER="andybioticlaw"
SERVICE_GROUP="andybioticlaw"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
STAGING_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# Default: hidden dotdir in the service user's home (openclaw style).
# /home/$USER is created by `useradd --create-home`; the dotdir below
# it is our app root.
INSTALL_DIR="${ANDYBIOTICLAW_INSTALL_DIR:-/home/$SERVICE_USER/.$SERVICE_USER}"
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

for bin in node sqlite3 logrotate rsync; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "required binary not found: $bin" >&2
    echo "  install with:  apt-get install -y nodejs sqlite3 logrotate rsync" >&2
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

if [[ ! -f "$STAGING_DIR/package.json" ]]; then
  echo "no package.json at $STAGING_DIR — this installer must run from scripts/install.sh in a cloned repo" >&2
  exit 1
fi

if [[ ! -f "$STAGING_DIR/dist/index.js" ]]; then
  echo "ERROR: $STAGING_DIR/dist/index.js not found — run 'pnpm build' before invoking this installer" >&2
  exit 1
fi

echo "✓ pre-flight OK (node $(node -v), sqlite3 $(sqlite3 -version | awk '{print $1}'))"
echo "  staging dir: $STAGING_DIR"
echo "  install dir: $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 2. System user (create if missing)
# ---------------------------------------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /bin/bash "$SERVICE_USER"
  echo "✓ created system user $SERVICE_USER (home=$HOME_DIR)"
else
  echo "✓ user $SERVICE_USER already exists"
fi

# Ensure the home dir exists AND is owned by the service user. When the
# user pre-exists from a partial install (or manual cleanup), `useradd
# --create-home` is skipped above, and a later `mkdir -p` would create
# /home/$USER as root. Without write access to its own home, the user
# can't create ~/.cache, which breaks `corepack` → `pnpm install`. So
# we explicitly fix it here, even on the "user already exists" path.
if [[ ! -d "$HOME_DIR" ]]; then
  mkdir -p "$HOME_DIR"
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$HOME_DIR"
chmod 755 "$HOME_DIR"
echo "✓ home dir $HOME_DIR is owned by $SERVICE_USER"

# ---------------------------------------------------------------------------
# 3. Copy source tree into INSTALL_DIR
# ---------------------------------------------------------------------------
# Ensures parent dir of INSTALL_DIR exists (it should, since useradd created
# /home/$USER, but a custom ANDYBIOTICLAW_INSTALL_DIR may point elsewhere).
mkdir -p "$(dirname "$INSTALL_DIR")"
mkdir -p "$INSTALL_DIR"

# rsync copies content, skips node_modules (we rebuild natively below) +
# .git + data (runtime state). --update leaves newer target files alone
# on re-installs. Source trailing slash is important.
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude 'data/' \
  "$STAGING_DIR"/ "$INSTALL_DIR"/
echo "✓ source synced into $INSTALL_DIR"

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"
# 0700 on the dotdir itself: only the service user can cd into it.
chmod 700 "$INSTALL_DIR"
# data/ subdirs (runtime state) stay 0700 too; created on first service
# boot by index.ts ensureDir(), but pre-created here so ownership is right.
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/data/logs" "$INSTALL_DIR/data/workspaces"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data"
echo "✓ ownership + permissions set (0700)"

# ---------------------------------------------------------------------------
# 4. Production deps (native modules compiled natively for this host)
# ---------------------------------------------------------------------------
echo "installing production dependencies (compiles better-sqlite3 + argon2 for this arch)…"
# Sanity: pnpm must be reachable for the service user via corepack
# shims, AND the user needs write access to its own home dir so
# corepack can create ~/.cache. The HOME_DIR chown above handles the
# latter; this check catches a missing pnpm shim before the install
# step fails opaquely.
if ! sudo -u "$SERVICE_USER" -H bash -lc 'command -v pnpm' >/dev/null 2>&1; then
  echo "✗ pnpm not on PATH for $SERVICE_USER. Run as root:" >&2
  echo "    corepack enable pnpm" >&2
  exit 1
fi
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && pnpm install --prod --frozen-lockfile"
# Verify deps actually landed — a silent pnpm failure would otherwise
# leave node_modules empty and the service crashes at first import.
if [[ ! -d "$INSTALL_DIR/node_modules/commander" ]]; then
  echo "✗ pnpm install completed but node_modules/commander missing — install failed silently" >&2
  exit 1
fi
echo "✓ deps installed"

if [[ ! -f "$INSTALL_DIR/web/dist/index.html" ]]; then
  echo "WARNING: $INSTALL_DIR/web/dist/index.html not found — dashboard UI will show placeholder" >&2
  echo "  on your dev machine:  pnpm --filter @andybioticlaw/web build" >&2
fi

# ---------------------------------------------------------------------------
# 4b. CLI wrapper on $PATH
# ---------------------------------------------------------------------------
# $INSTALL_DIR/bin/andybioticlaw is a small bash wrapper that execs
# `node $INSTALL_DIR/dist/cli/admin.js "$@"`. We symlink it into
# /usr/local/bin so BOTH the principal's shell and the service-user's
# non-interactive subprocess env can invoke `andybioticlaw` without a
# hard-coded path.
if [[ -f "$INSTALL_DIR/bin/andybioticlaw" ]]; then
  chmod +x "$INSTALL_DIR/bin/andybioticlaw"
  ln -sf "$INSTALL_DIR/bin/andybioticlaw" /usr/local/bin/andybioticlaw
  echo "✓ andybioticlaw CLI symlinked into /usr/local/bin/"
else
  echo "WARNING: $INSTALL_DIR/bin/andybioticlaw not found — CLI not linked on \$PATH" >&2
fi

# ---------------------------------------------------------------------------
# 5. Render + install systemd unit
# ---------------------------------------------------------------------------
# Template ships with __INSTALL_DIR__ and __SERVICE_HOME__ placeholders;
# sed substitutes both with the concrete paths before copying to
# /etc/systemd/system/.
SERVICE_TEMPLATE="$INSTALL_DIR/systemd/andybioticlaw.service.template"
if [[ -f "$SERVICE_TEMPLATE" ]]; then
  # Pipe delimiter so install paths with / don't need escaping.
  sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      -e "s|__SERVICE_HOME__|$HOME_DIR|g" \
      "$SERVICE_TEMPLATE" \
    > "$SYSTEMD_DIR/andybioticlaw.service"
  chmod 0644 "$SYSTEMD_DIR/andybioticlaw.service"
  echo "✓ rendered + installed andybioticlaw.service"
else
  echo "skip missing $SERVICE_TEMPLATE" >&2
fi
systemctl daemon-reload
systemctl enable andybioticlaw.service >/dev/null
echo "✓ systemd unit enabled (main service NOT started yet — see next steps)"

# ---------------------------------------------------------------------------
# 6. Render + install logrotate config
# ---------------------------------------------------------------------------
LOGROTATE_TEMPLATE="$INSTALL_DIR/systemd/andybioticlaw.logrotate.template"
if [[ -f "$LOGROTATE_TEMPLATE" ]]; then
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$LOGROTATE_TEMPLATE" \
    > "$LOGROTATE_FILE"
  chmod 0644 "$LOGROTATE_FILE"
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

  1. Switch to the service user:
       sudo -iu $SERVICE_USER

  2. Log into Claude (subscription credentials):
       claude login
     (OAuth flow — open the URL, paste the code back.)

  3. Launch the interactive menu and run setup:
       andybioticlaw
     (Arrow keys + Enter. Select "Run setup wizard".)

  4. Back as admin, start the service:
       exit           # leave the $SERVICE_USER shell
       systemctl start andybioticlaw
       systemctl status andybioticlaw

  5. Follow logs:
       journalctl -u andybioticlaw -f
     or:
       tail -f $INSTALL_DIR/data/logs/andybioticlaw.log

  6. (Optional) Expose the dashboard beyond 127.0.0.1:18790.
     See docs/DEPLOYMENT.md § 10 for reverse-proxy + basic-auth.

Backups are NOT handled by this service — use your VPS provider's
snapshots or your preferred tool (restic, borg, etc.) to back up
$INSTALL_DIR/data/ (SQLite DB + logs + session workspaces).
=========================================================================
EOF
