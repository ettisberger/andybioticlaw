#!/usr/bin/env bash
# google-calendar skill — one-time OAuth device-flow handshake.
#
# Runs after `andybioticlaw skill setup google-calendar` collected the
# client_id and client_secret and appended them to .env. Obtains a
# long-lived `refresh_token` from Google via the device-code OAuth flow
# and appends it to .env as `GOOGLE_CALENDAR_REFRESH_TOKEN`.
#
# Idempotent: if the refresh token is already set, exits clean.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Walk up to find .env (skills/google-calendar/../../.env).
ENV_FILE="$(cd "$SCRIPT_DIR/../.." && pwd -P)/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ could not locate .env at $ENV_FILE" >&2
  exit 1
fi

# Load whatever's currently set.
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ -z "${GOOGLE_CALENDAR_CLIENT_ID:-}" ]] || [[ -z "${GOOGLE_CALENDAR_CLIENT_SECRET:-}" ]]; then
  echo "✗ GOOGLE_CALENDAR_CLIENT_ID / _CLIENT_SECRET missing from .env." >&2
  echo "  Run 'andybioticlaw skill setup google-calendar' (wizard) first." >&2
  exit 1
fi

if [[ -n "${GOOGLE_CALENDAR_REFRESH_TOKEN:-}" ]]; then
  echo "✓ GOOGLE_CALENDAR_REFRESH_TOKEN already set — skipping device-flow."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: ask Google for a device + user code.
# ---------------------------------------------------------------------------
echo "▸ requesting device code from Google…"
DEVICE_RES="$(curl -sfS \
  --max-time 15 \
  -X POST \
  -d "client_id=${GOOGLE_CALENDAR_CLIENT_ID}" \
  -d "scope=https://www.googleapis.com/auth/calendar" \
  "https://oauth2.googleapis.com/device/code")"

# Minimal JSON field extraction — no jq required. These fields are simple
# strings without embedded quotes, so grep + sed works reliably.
extract() {
  echo "$DEVICE_RES" | grep -o "\"$1\":\"[^\"]*\"" | sed "s/^\"$1\":\"//;s/\"$//"
}
extract_num() {
  echo "$DEVICE_RES" | grep -o "\"$1\":[0-9]*" | sed "s/^\"$1\"://"
}

DEVICE_CODE="$(extract device_code)"
USER_CODE="$(extract user_code)"
VERIFICATION_URL="$(extract verification_url)"
POLL_INTERVAL="$(extract_num interval)"
EXPIRES_IN="$(extract_num expires_in)"

if [[ -z "$DEVICE_CODE" ]] || [[ -z "$USER_CODE" ]]; then
  echo "✗ unexpected response from Google:" >&2
  echo "  $DEVICE_RES" >&2
  exit 2
fi

echo
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  ✨ Authorize this app:                                       "
printf  "│     Visit:  %s\n" "$VERIFICATION_URL"
printf  "│     Code:   %s\n" "$USER_CODE"
echo "│"
printf  "│     (code expires in %ss — waiting for you to approve…)\n" "$EXPIRES_IN"
echo "└─────────────────────────────────────────────────────────────┘"
echo

# ---------------------------------------------------------------------------
# Step 2: poll Google until the user approves (or the code expires).
# ---------------------------------------------------------------------------
DEADLINE=$(( $(date +%s) + EXPIRES_IN ))
SLEEP_SEC="${POLL_INTERVAL:-5}"
REFRESH_TOKEN=""

while [[ $(date +%s) -lt $DEADLINE ]]; do
  sleep "$SLEEP_SEC"

  POLL_RES="$(curl -sS \
    --max-time 15 \
    -X POST \
    -d "client_id=${GOOGLE_CALENDAR_CLIENT_ID}" \
    -d "client_secret=${GOOGLE_CALENDAR_CLIENT_SECRET}" \
    -d "device_code=${DEVICE_CODE}" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
    "https://oauth2.googleapis.com/token" || true)"

  # `refresh_token` field only present on a successful response.
  POLL_REFRESH="$(echo "$POLL_RES" | grep -o '"refresh_token":"[^"]*"' | sed 's/^"refresh_token":"//;s/"$//')"
  POLL_ERROR="$(echo "$POLL_RES" | grep -o '"error":"[^"]*"' | sed 's/^"error":"//;s/"$//')"

  if [[ -n "$POLL_REFRESH" ]]; then
    REFRESH_TOKEN="$POLL_REFRESH"
    break
  fi
  if [[ "$POLL_ERROR" == "authorization_pending" ]]; then
    echo "▸ waiting… (visit the URL above and enter the code)"
    continue
  fi
  if [[ "$POLL_ERROR" == "slow_down" ]]; then
    SLEEP_SEC=$(( SLEEP_SEC + 5 ))
    continue
  fi
  if [[ "$POLL_ERROR" == "access_denied" ]]; then
    echo "✗ user declined authorization. Aborting." >&2
    exit 3
  fi
  if [[ "$POLL_ERROR" == "expired_token" ]]; then
    echo "✗ device code expired before approval. Re-run the setup wizard." >&2
    exit 4
  fi
  # Any other error → print + retry until deadline.
  if [[ -n "$POLL_ERROR" ]]; then
    echo "  (Google: $POLL_ERROR — retrying)"
  fi
done

if [[ -z "$REFRESH_TOKEN" ]]; then
  echo "✗ timed out waiting for authorization. Re-run the setup wizard." >&2
  exit 4
fi

# ---------------------------------------------------------------------------
# Step 3: append the refresh token to .env.
# ---------------------------------------------------------------------------
# Append rather than rewrite so we don't race with other installers.
{
  echo ""
  echo "# added by google-calendar install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "GOOGLE_CALENDAR_REFRESH_TOKEN=${REFRESH_TOKEN}"
} >> "$ENV_FILE"

# Make sure .env is still 0600 (principal-only).
chmod 0600 "$ENV_FILE"

echo
echo "✓ refresh token saved. The google-calendar MCP server will now boot with full access."
echo "  To revoke: https://myaccount.google.com/permissions"
