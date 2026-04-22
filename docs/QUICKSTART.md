# Quickstart — bare-VPS to answering bot in ~30 minutes

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
- About 30 minutes.

You do not need:

- A local development machine.
- Docker, Node installed anywhere except the VPS.
- A domain name (until you want the dashboard public).

## 1. Create a Telegram bot (2 min)

1. On your phone, open Telegram and search for `@BotFather`.
2. Send `/newbot`. BotFather asks for a display name (anything you
   like, e.g. `Emma`) and a `@username` (must end in `bot`, e.g.
   `my_emma_bot`).
3. BotFather replies with a token like `1234567890:ABCDEF…`. Keep
   this tab open — you will paste the token in step 6.
4. While still in Telegram, search for `@userinfobot` and send it any
   message. It replies with your numeric user id. Note it down; you
   are the bot's only allowed user.

## 2. SSH in and install system dependencies (5 min)

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

## 3. Clone, build, install (5 min)

```bash
cd /tmp
git clone https://github.com/<your-fork-or-upstream>/andybioticlaw.git
cd andybioticlaw

pnpm install --frozen-lockfile
pnpm build
pnpm --filter @andybioticlaw/web build

# Run the production installer. It creates the `andybioticlaw` service
# user, copies the source into `/home/andybioticlaw/.andybioticlaw/`
# (mode 0700), re-compiles native deps for the VPS arch, renders + installs
# the systemd unit + logrotate config, and symlinks `andybioticlaw` into
# `/usr/local/bin/`.
sudo bash scripts/install.sh
```

## 4. Switch to the service user (1 min)

```bash
sudo -iu andybioticlaw
```

You are now in a shell as the `andybioticlaw` service user. Everything
from here runs with the service's own home + permissions — including the
Claude OAuth credentials which must land in this user's `~/.claude/`.

## 5. Log into Claude (3 min)

```bash
claude login
```

OAuth flow: open the URL it prints in a browser on any machine (doesn't
have to be the VPS), paste the confirmation code back in the SSH session.
Verify:

```bash
claude auth status --json
# expect: "loggedIn": true, "apiKeySource": "none",
#         "subscriptionType": "pro" or "max".
```

If `apiKeySource` is anything other than `"none"`, the service will
refuse to start sessions — see `docs/SECURITY.md` § 1 for why.

## 6. Run the interactive menu (3 min)

```bash
andybioticlaw
```

Arrow keys + Enter. Select **"Run setup wizard"**. The wizard asks four
things:

1. **Bot token** (from step 1) — stored in `.env` with mode 0600.
2. **Your numeric Telegram user id** (from step 1) — written into
   `config.yaml` as the only DM-allowed user.
3. **Timezone** — defaults to the VPS's system timezone.
4. **Dashboard password** — required (the service refuses to start with
   basic-auth enabled but no hash); press Enter to explicitly disable
   basic-auth for a localhost-only dev setup.

Already-set values are reused, so re-running is safe.

When done, type `exit` to leave the service-user shell and return to
your admin user.

## 7. Start the service (2 min)

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

## 8. Send your first DM (1 min)

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

## What's next

- **Production hardening:** `docs/DEPLOYMENT.md` walks through SSH
  hardening, UFW, the nginx + certbot reverse-proxy for the dashboard,
  and backup-timer verification.
- **Add a skill:** `skills/README.md` documents the contract. Start
  with `skills/_template/` — copy the folder, fill in manifest + SKILL.md.
- **Security posture:** `docs/SECURITY.md` enumerates trust boundaries
  and enforcement layers. Read it before giving the bot access to
  anything sensitive.
- **Backups:** out of scope — use your VPS provider's snapshots or a
  tool like `restic` / `borg` to back up `/home/andybioticlaw/.andybioticlaw/data/`.
  Config + `.env` live elsewhere and should be backed up separately.
  See `docs/DEPLOYMENT.md` § 9.
