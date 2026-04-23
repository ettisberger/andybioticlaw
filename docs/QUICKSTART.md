# Quickstart

This is the **happy path**: fresh Ubuntu VPS, minimal config, your bot
answering its first DM. No hardening detours, no reverse proxy, no TLS.
For the full production story (SSH hardening, dashboard exposure,
nginx + certbot, backup verification), read **`docs/DEPLOYMENT.md`**
after you have a working bot.

## Before you start

You need:

- A bare Ubuntu 24.04 VPS with root/sudo access (Hetzner CX22 is fine;
  2 GB RAM is comfortable).
- A Claude subscription (Pro or Max) — the service refuses to run on
  pay-as-you-go API-key billing.
- A Telegram account on your phone.

You do not need:

- A local development machine.
- Docker, Node installed anywhere except the VPS.
- A domain name (until you want the dashboard public).

## 1. Create a Telegram bot

1. On your phone, open Telegram and search for `@BotFather`.
2. Send `/newbot`. BotFather asks for a display name (anything you
   like, e.g. `Emma`) and a `@username` (must end in `bot`, e.g.
   `my_emma_bot`).
3. BotFather replies with a token like `1234567890:ABCDEF…`. Keep
   this tab open — you will paste the token in step 6.
4. While still in Telegram, search for `@userinfobot` and send it any
   message. It replies with your numeric user id. Note it down; you
   are the bot's only allowed user.

## 2. SSH in and install system dependencies

```bash
ssh root@<vps-ip>

apt-get update
apt-get install -y \
  curl ca-certificates sqlite3 logrotate git build-essential \
  python3 python3-dev

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
corepack enable pnpm

# Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash
```

Check everything answers:

```bash
node -v        # v20.x or newer
pnpm -v
claude --version
```

## 3. Download and install

Get the source into a persistent folder in your admin user's home, then run the installer.

```bash
mkdir -p ~/andybioticlaw && cd ~/andybioticlaw
curl -fsSL https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz \
  | tar xz --strip-components=1
sudo bash scripts/install.sh
```

The installer creates the `andybioticlaw` service user, copies the
source into `/home/andybioticlaw/.andybioticlaw/` (mode 0700), runs
`pnpm install --prod --frozen-lockfile` as the service user to
compile `better-sqlite3` + `argon2` natively for the VPS, renders +
installs the systemd unit + logrotate config, and symlinks
`andybioticlaw` into `/usr/local/bin/`.

> **Contributor / tip-of-main install?** Replace the two `curl | tar`
> lines above with:
> ```bash
> git clone https://github.com/ettisberger/andybioticlaw.git ~/andybioticlaw
> cd ~/andybioticlaw
> pnpm install --frozen-lockfile && pnpm -r build
> ```
> Then `sudo bash scripts/install.sh` as usual.

## 4. Switch to the service user

```bash
sudo -iu andybioticlaw
```

You are now in a shell as the `andybioticlaw` service user. Everything
from here runs with the service's own home + permissions — including the
Claude OAuth credentials which must land in this user's `~/.claude/`.

## 5. Authenticate the Claude CLI

Two ways, both subscription-billed (NOT pay-as-you-go API credits). Pick one:

### 5a. Long-lived OAuth token (recommended for unattended servers)

```bash
claude setup-token
```

Follow the OAuth flow; the command prints a token starting with
`sk-ant-oat-...` that lasts **1 year**. Copy it. You'll paste it into
the wizard in step 6 (which writes it to `.env` as
`CLAUDE_CODE_OAUTH_TOKEN`). No periodic re-login required.

Requires a Claude Pro / Max / Team / Enterprise subscription.

### 5b. Interactive OAuth session

```bash
claude login
```

OAuth flow: open the URL it prints in a browser on any machine (doesn't
have to be the VPS), paste the confirmation code back in the SSH session.
Session credentials land in `~/.claude/.credentials.json` and
auto-refresh on expiry. Every few months the refresh token may rotate
and you'll need to re-run `claude login` — fine for interactive use,
less great for truly unattended deployments.

Either way, verify:

```bash
claude auth status --json
# expect: "loggedIn": true,
#         "subscriptionType": "pro" | "max" | "team" | "enterprise".
# apiKeySource will be "none" (session) or a CLAUDE_CODE_OAUTH_TOKEN marker.
# Must NOT be "ANTHROPIC_API_KEY" — that's pay-as-you-go billing and
# the service will refuse to boot on it.
```

See `docs/SECURITY.md` § 1 for the subscription-enforcement details.

> **April 2026 heads-up**: Anthropic enforces against third-party 24/7
> agent harnesses using subscription credentials. Both paths above
> still work, but always-on self-hosted operation is at your own risk.

## 6. Run the interactive menu

```bash
andybioticlaw
```

Arrow keys + Enter. Select **"Run setup wizard"**. The wizard asks five
things:

1. **Bot token** (from step 1) — stored in `.env` with mode 0600.
2. **Your numeric Telegram user id** (from step 1) — written into
   `config.yaml` as the only DM-allowed user.
3. **Timezone** — defaults to the VPS's system timezone.
4. **Dashboard password** — required (the service refuses to start with
   basic-auth enabled but no hash); press Enter to explicitly disable
   basic-auth for a localhost-only dev setup.
5. **Claude auth** — pick "Paste a long-lived OAuth token" and paste
   the `sk-ant-oat-...` you got in step 5a, OR pick "Skip" if you ran
   `claude login` in step 5b.

Already-set values are reused, so re-running is safe.

When done, type `exit` to leave the service-user shell and return to
your admin user.

## 7. Start the service

```bash
sudo systemctl start andybioticlaw
sudo systemctl status andybioticlaw   # expect active (running)
```

Watch the log to see it boot cleanly:

```bash
sudo journalctl -u andybioticlaw -f
```

Expected sequence over a few seconds:

```
andybioticlaw starting (agent: Emma, model: claude-opus-4-7)
applied migration ... (first boot only)
claude credentials OK (subscription: max)
0 skill(s) loaded
ready
telegram bot polling started
```

## 8. Send your first DM

1. On your phone, open the Telegram chat with the @username bot you
   created in step 1 (search for it, `/start`).
2. Send `hi`.
3. The bot answers.

If it doesn't, check:

- `sudo journalctl -u andybioticlaw -n 50` — look for errors.
- `sudo -u andybioticlaw andybioticlaw config validate` — reprints the
  currently-loaded config so you can spot a bad user id or timezone.
- BotFather: confirm no second process is polling the same token (the
  Telegram API enforces exclusivity).

## Updating later

When a new release lands upstream:

```bash
sudo -iu andybioticlaw
andybioticlaw update    # tarball install → fetches the newer release
                         # git-clone install → git pull + rebuild
exit
sudo systemctl restart andybioticlaw
```

`andybioticlaw update` auto-detects which install mode you used
(presence of `.git/` in the install dir) and does the right thing.
`data/`, `config/config.yaml`, and `.env` are preserved across
updates — only code + deps get replaced.

See `docs/DEPLOYMENT.md` § 11 for the step-by-step redeploy flow with
common failure modes.
