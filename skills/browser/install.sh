#!/usr/bin/env bash
# browser skill installer.
#
# Steps:
#   1. Verify environment: disk space, noexec, node version.
#   2. Install MCP server deps via `npm install` (Playwright is the heavy one).
#   3. Install Chromium browser binary into PLAYWRIGHT_BROWSERS_PATH —
#      pointed at <install-dir>/data/cache/playwright so it lands under
#      the writable systemd ReadWritePaths.
#   4. Install Chromium runtime apt libs via `npx playwright install-deps`
#      (needs sudo; we re-exec with sudo if not root). Operator can skip
#      with --no-system-deps if they've already installed them.
#
# Idempotent — re-running is safe; the npm + playwright install commands
# no-op when the targets are already present.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# skill is at <install-dir>/skills/browser/ — install-dir is two levels up.
INSTALL_DIR="$(cd "$SKILL_DIR/../.." && pwd -P)"
SERVER_DIR="$SKILL_DIR/mcp-server"
BROWSERS_DIR="$INSTALL_DIR/data/cache/playwright"
PROFILES_DIR="$INSTALL_DIR/data/browser/profiles"
SCREENSHOTS_DIR="$INSTALL_DIR/data/browser/screenshots"

SKIP_SYSTEM_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --no-system-deps) SKIP_SYSTEM_DEPS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 64 ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 1: preflight
# ---------------------------------------------------------------------------

# Disk: Playwright Chromium is ~170 MB, plus per-profile user-data-dirs
# (~10-50 MB each over time). Demand 500 MB free under data/ to avoid a
# half-extracted browser leaving the install in a wedged state.
echo "▸ preflight: checking disk + mount options under $INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/data"
AVAIL_KB="$(df -k "$INSTALL_DIR/data" | awk 'NR==2 {print $4}')"
if [[ -z "$AVAIL_KB" ]] || [[ "$AVAIL_KB" -lt 512000 ]]; then
  echo "✗ not enough free space under $INSTALL_DIR/data (need ~500 MB, have ${AVAIL_KB:-0} KB)" >&2
  exit 1
fi

# noexec on the data mount would silently break Chromium launch with a
# confusing 'Permission denied' on the chromium binary. Catch it up front.
if findmnt -no OPTIONS --target "$INSTALL_DIR/data" 2>/dev/null | grep -q '\bnoexec\b'; then
  echo "✗ $INSTALL_DIR/data is on a noexec mount — Chromium will not launch." >&2
  echo "  Either remount without noexec or move data/ to a different filesystem." >&2
  exit 1
fi

# Node 20+
NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || echo 'missing')"
if [[ "$NODE_VERSION" == "missing" ]]; then
  echo "✗ node is not installed on PATH" >&2
  exit 1
fi
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "✗ node 20+ required (have $NODE_VERSION)" >&2
  exit 1
fi
echo "  ✓ disk ok, node $NODE_VERSION"

# ---------------------------------------------------------------------------
# Step 2: ensure runtime dirs exist with correct modes.
# ---------------------------------------------------------------------------
mkdir -p "$BROWSERS_DIR" "$PROFILES_DIR" "$SCREENSHOTS_DIR"
chmod 0700 "$PROFILES_DIR"

# ---------------------------------------------------------------------------
# Step 3: MCP server deps
# ---------------------------------------------------------------------------
echo "▸ installing MCP server deps (playwright + sdk)…"
cd "$SERVER_DIR"
# --omit=dev keeps the install lean. The skill's mcp-server has no test deps.
npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Step 4: Chromium browser binary into our writable path.
# ---------------------------------------------------------------------------
echo "▸ installing Chromium into $BROWSERS_DIR…"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
  npx --yes playwright install chromium

# ---------------------------------------------------------------------------
# Step 5: Chromium runtime apt libs (needs sudo).
# ---------------------------------------------------------------------------
if [[ "$SKIP_SYSTEM_DEPS" -eq 1 ]]; then
  echo "▸ skipping playwright install-deps (--no-system-deps)"
else
  echo "▸ installing Chromium runtime libs (apt) — needs sudo"
  if [[ "$EUID" -ne 0 ]]; then
    sudo PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
      npx --yes playwright install-deps chromium
  else
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
      npx --yes playwright install-deps chromium
  fi
fi

echo
echo "✓ browser skill installed."
echo "  Chromium binaries:   $BROWSERS_DIR"
echo "  Per-profile data:    $PROFILES_DIR"
echo "  Screenshots:         $SCREENSHOTS_DIR"
echo
echo "Next steps:"
echo "  1. Add a 'browser:' block to config/config.yaml (see config.example.yaml)."
echo "  2. Define at least one profile + a hostname allowlist."
echo "  3. Restart the service ('andybioticlaw config reload' is not enough — profiles[] is restart-required)."
echo "  4. Run 'andybioticlaw browser status' to verify the skill is live."
