#!/usr/bin/env bash
# hue skill — Philips Hue Remote API pairing.
#
# Runs after the wizard captured CLIENT_ID + CLIENT_SECRET + REDIRECT_URI.
# Completes the OAuth 2.0 authorization-code flow (code pasted from a
# browser), discovers the bridge id, and prompts the operator to press
# the physical link button so a long-lived bridge "username" can be
# minted. All four derived secrets are appended to .env.
#
# Idempotent: if HUE_USERNAME is already set we assume the pairing is
# complete and exit clean.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Walk up to find .env (skills/hue/../../.env).
ENV_FILE="$(cd "$SCRIPT_DIR/../.." && pwd -P)/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ could not locate .env at $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ -z "${HUE_CLIENT_ID:-}" ]] || [[ -z "${HUE_CLIENT_SECRET:-}" ]] || [[ -z "${HUE_REDIRECT_URI:-}" ]]; then
  echo "✗ HUE_CLIENT_ID / HUE_CLIENT_SECRET / HUE_REDIRECT_URI missing from .env." >&2
  echo "  Run 'andybioticlaw skill setup hue' (wizard) first." >&2
  exit 1
fi

if [[ -n "${HUE_USERNAME:-}" ]] && [[ -n "${HUE_ACCESS_TOKEN:-}" ]] && [[ -n "${HUE_BRIDGE_ID:-}" ]]; then
  echo "✓ hue bridge pairing already present — skipping."
  echo "  (to re-pair, delete HUE_USERNAME from $ENV_FILE and re-run)"
  exit 0
fi

# ---------------------------------------------------------------------------
# JSON field extractors — minimal grep/sed, same pattern as google-calendar.
# `|| true` on each pipeline so `set -euo pipefail` doesn't nuke us when a
# field is absent (expected on partial / error responses).
# `[[:space:]]*` because Philips's API pretty-prints ("key": "value" with a
# space after the colon).
# ---------------------------------------------------------------------------
extract_str_from() {
  # $1 = json body, $2 = key name
  echo "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | \
    sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*\"//; s/\"$//" || true
}
extract_num_from() {
  echo "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*[0-9]+" | \
    sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*//" || true
}

# ---------------------------------------------------------------------------
# Step 1: print auth URL and read the authorization code back from stdin.
# ---------------------------------------------------------------------------
# Random state so we're not completely defenceless against an attacker who
# can race the redirect (though for this flow it's mostly a formality).
STATE="$(head -c 12 /dev/urandom | base64 | tr -d '=/+' || date +%s)"

# URL-encode the redirect_uri (just the minimum — `:` and `/` are the ones
# that matter here; anything fancier and we'd need python/jq).
ENCODED_REDIRECT="$(printf %s "$HUE_REDIRECT_URI" | \
  sed -E 's,:,%3A,g; s,/,%2F,g')"

AUTH_URL="https://api.meethue.com/v2/oauth2/authorize?client_id=${HUE_CLIENT_ID}&response_type=code&state=${STATE}&redirect_uri=${ENCODED_REDIRECT}"

echo
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  ✨ Authorize this app:                                       "
echo "│                                                              "
printf  "│     %s\n" "$AUTH_URL"
echo "│                                                              "
echo "│     After you authorize, your browser will redirect to       "
echo "│     $HUE_REDIRECT_URI"
echo "│     with ?code=XXXX&state=… in the URL bar. Copy the value   "
echo "│     of the 'code' parameter (everything between 'code=' and  "
echo "│     the next '&') and paste it below.                        "
echo "└─────────────────────────────────────────────────────────────┘"
echo

printf "code: "
read -r HUE_CODE
HUE_CODE="${HUE_CODE//[[:space:]]/}"

if [[ -z "$HUE_CODE" ]]; then
  echo "✗ no code received — aborting." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Step 2: exchange the code for access + refresh tokens.
# ---------------------------------------------------------------------------
echo "▸ exchanging code for tokens…"

TOKEN_RES="$(curl -sS \
  --max-time 15 \
  -X POST \
  -u "${HUE_CLIENT_ID}:${HUE_CLIENT_SECRET}" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${HUE_CODE}" \
  --data-urlencode "redirect_uri=${HUE_REDIRECT_URI}" \
  "https://api.meethue.com/v2/oauth2/token")"

TOKEN_ERR="$(extract_str_from "$TOKEN_RES" error)"
if [[ -n "$TOKEN_ERR" ]]; then
  TOKEN_DESC="$(extract_str_from "$TOKEN_RES" error_description)"
  echo "✗ Philips rejected the code exchange:" >&2
  echo "    error: $TOKEN_ERR" >&2
  [[ -n "$TOKEN_DESC" ]] && echo "    description: $TOKEN_DESC" >&2
  echo "" >&2
  case "$TOKEN_ERR" in
    invalid_grant|invalid_request)
      echo "  Fix: the code expired (they only last ~60s) or the" >&2
      echo "  redirect_uri you registered doesn't match what's in .env." >&2
      echo "  Confirm HUE_REDIRECT_URI exactly matches the value on" >&2
      echo "  https://developers.meethue.com/my-apps, then re-run the wizard." >&2
      ;;
    invalid_client|unauthorized_client)
      echo "  Fix: CLIENT_ID/CLIENT_SECRET mismatch. Re-copy from" >&2
      echo "  https://developers.meethue.com/my-apps and re-run the wizard." >&2
      ;;
  esac
  exit 2
fi

HUE_ACCESS_TOKEN_NEW="$(extract_str_from "$TOKEN_RES" access_token)"
HUE_REFRESH_TOKEN_NEW="$(extract_str_from "$TOKEN_RES" refresh_token)"
TOKEN_EXPIRES_IN="$(extract_num_from "$TOKEN_RES" expires_in)"

if [[ -z "$HUE_ACCESS_TOKEN_NEW" ]] || [[ -z "$HUE_REFRESH_TOKEN_NEW" ]]; then
  echo "✗ unexpected response from Philips token endpoint:" >&2
  echo "  $TOKEN_RES" >&2
  exit 2
fi
echo "  ✓ access token received (expires in ${TOKEN_EXPIRES_IN:-?}s, refresh token saved)."

# ---------------------------------------------------------------------------
# Step 3: discover the bridge id.
# ---------------------------------------------------------------------------
echo "▸ discovering bridge id…"

BRIDGE_RES="$(curl -sS \
  --max-time 15 \
  -H "Authorization: Bearer ${HUE_ACCESS_TOKEN_NEW}" \
  "https://api.meethue.com/route/api/0/config")"

HUE_BRIDGE_ID_NEW="$(extract_str_from "$BRIDGE_RES" bridgeid)"

if [[ -z "$HUE_BRIDGE_ID_NEW" ]]; then
  echo "✗ could not discover bridge id. Raw response:" >&2
  echo "  $BRIDGE_RES" >&2
  echo "" >&2
  echo "  If your Hue account has no bridge linked, add one via the" >&2
  echo "  Philips Hue mobile app first, then re-run this setup." >&2
  exit 3
fi
echo "  ✓ bridge id: $HUE_BRIDGE_ID_NEW"

# ---------------------------------------------------------------------------
# Step 4: ask operator to press link button, then mint the username.
# ---------------------------------------------------------------------------
echo
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  🔘 Press the physical button on your Hue bridge NOW.        "
echo "│                                                              "
echo "│  You have ~30 seconds after the button press to complete     "
echo "│  the pairing. Press Enter here once you've pressed it.       "
echo "└─────────────────────────────────────────────────────────────┘"
read -r _

echo "▸ creating bridge username…"

HUE_USERNAME_NEW=""
DEADLINE=$(( $(date +%s) + 30 ))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  USER_RES="$(curl -sS \
    --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${HUE_ACCESS_TOKEN_NEW}" \
    -H "Content-Type: application/json" \
    -d '{"devicetype":"andybioticlaw#hue"}' \
    "https://api.meethue.com/route/api" || true)"

  POSSIBLE_USERNAME="$(extract_str_from "$USER_RES" username)"
  POSSIBLE_ERR="$(extract_str_from "$USER_RES" description)"

  if [[ -n "$POSSIBLE_USERNAME" ]]; then
    HUE_USERNAME_NEW="$POSSIBLE_USERNAME"
    break
  fi

  # The canonical "button not pressed" response includes
  # `"description": "link button not pressed"`. Anything else we surface.
  if [[ -n "$POSSIBLE_ERR" ]] && [[ "$POSSIBLE_ERR" != *"link button not pressed"* ]]; then
    echo "  (Hue: $POSSIBLE_ERR — retrying)"
  fi
  sleep 2
done

if [[ -z "$HUE_USERNAME_NEW" ]]; then
  echo "✗ timed out waiting for link-button press." >&2
  echo "  Re-run the setup and press the button within 30s of the prompt." >&2
  exit 4
fi

echo "  ✓ username created."

# ---------------------------------------------------------------------------
# Step 5: append to .env. Append rather than rewrite so we don't race with
# other installers or clobber operator-managed config.
# ---------------------------------------------------------------------------
{
  echo ""
  echo "# added by hue install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "HUE_ACCESS_TOKEN=${HUE_ACCESS_TOKEN_NEW}"
  echo "HUE_REFRESH_TOKEN=${HUE_REFRESH_TOKEN_NEW}"
  echo "HUE_BRIDGE_ID=${HUE_BRIDGE_ID_NEW}"
  echo "HUE_USERNAME=${HUE_USERNAME_NEW}"
} >> "$ENV_FILE"

chmod 0600 "$ENV_FILE"

echo
echo "✓ hue skill paired. Emma can now list and control your lights, rooms, and scenes."
echo "  To revoke: revisit https://account.meethue.com and remove the app under 'Connected services'."
