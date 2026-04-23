# Production deployment on a Linux VPS

Target: a bare Linux VPS (x86_64 or arm64) with `systemd`, running
Ubuntu 24.04 LTS or similar. The service is I/O-bound — 1 vCPU + 2 GB
RAM is comfortable, budget-VPS-class is fine. Tested end-to-end on
Hetzner Cloud (CPX11); Vultr / DigitalOcean / Linode / bare-metal all
work the same way as long as systemd + apt-based package management is
present.

Two install paths exist — pick one:

- **Release tarball** (recommended for most operators) — fixed version,
  no build toolchain needed on the server. You still get updates via
  re-downloading the next release.
- **Git clone** (for contributors or anyone who wants to track `main`)
  — needs `git`, `node`, and `pnpm` on the server to build from source.

This guide covers both. § 4 splits into 4a (tarball) and 4b (clone);
the rest is shared.

## 1. Provision the box

Whatever provider you use, target:

- Image: Ubuntu 24.04 LTS (other Debian-derivatives work; adjust
  `apt-get` to your distro if you're on RHEL/Fedora/etc.)
- Size: 1 vCPU + 2 GB RAM is comfortable.
- Networking: IPv4 + IPv6.
- SSH key: add yours so you can log in as `root`.

**Example — Hetzner Cloud:** New Server → Location (any) → Image
(Ubuntu 24.04) → Type (CX22 or CPX11) → SSH key. Other providers have
equivalent wizards.

SSH in as root:

```bash
ssh root@<vps-ip>
```

## 2. Harden the base image

```bash
# Non-root admin user (pick whatever username you prefer — `ADMIN_USER`
# is used throughout the rest of this guide as a placeholder).
ADMIN_USER=myname
adduser "$ADMIN_USER" --disabled-password --gecos ""
usermod -aG sudo "$ADMIN_USER"
mkdir "/home/$ADMIN_USER/.ssh"
cp ~/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/"
chown -R "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
chmod 700 "/home/$ADMIN_USER/.ssh"
chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys"

# Disable root SSH + password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall — only SSH reachable from the internet
apt-get update && apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

exit
ssh "$ADMIN_USER"@<vps-ip>    # re-login as the non-root user
```

## 3. Install system dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  curl ca-certificates sqlite3 logrotate git build-essential \
  python3 python3-dev

# Node.js 20 LTS via NodeSource (or use Ubuntu's newer Node if you prefer).
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # expect v20.x.x or newer
```

pnpm (via corepack, bundled with Node):

```bash
sudo corepack enable pnpm
pnpm -v
```

Claude Code CLI (uses subscription auth):

```bash
# Official install script; check https://docs.claude.com/ for the latest.
curl -fsSL https://claude.ai/install.sh | sudo bash
claude --version
```

## 4. Get the source on the box

Pick the path that matches your install style.

### 4a. Release tarball (recommended)

No build toolchain required beyond what's in `§ 3`. You still need
`pnpm` because `install.sh` runs `pnpm install --prod
--frozen-lockfile` as the service user to compile the native modules
(`better-sqlite3`, `argon2`) for the VPS's architecture. But no
TypeScript compile happens — the tarball ships `dist/` + `web/dist/`
pre-built.

```bash
cd ~
curl -fsSL -o /tmp/andybioticlaw.tar.gz \
  https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz
mkdir andybioticlaw && cd andybioticlaw
tar xzf /tmp/andybioticlaw.tar.gz --strip-components=1
rm /tmp/andybioticlaw.tar.gz
```

`~/andybioticlaw/` is now your staging tree. For a future upgrade you
re-download the newer tarball, re-extract into the same dir, re-run
`scripts/install.sh`.

### 4b. Git clone (for contributors / tip-of-main)

Clone into your admin user's home (**not `/tmp`** — you want this
persistent so `andybioticlaw update` can run `git pull` against it):

```bash
cd ~
git clone https://github.com/ettisberger/andybioticlaw.git
cd andybioticlaw

pnpm install --frozen-lockfile
pnpm build
pnpm --filter @andybioticlaw/web build
```

`~/andybioticlaw/` is now your staging tree. The installer in the next
step copies the built artifacts out of here into the service user's
home dotdir; your staging clone remains intact for future updates
(`git pull && pnpm install --frozen-lockfile && pnpm build` — or just
run `andybioticlaw update`).

> **Build-locally variant:** if you prefer not to install build-tools
> on the VPS, build on your laptop and rsync:
> `rsync -avz --delete --exclude='node_modules/' --exclude='data/' --exclude='.git/' ./ <vps>:~/andybioticlaw/`
> — then continue with § 5 on the VPS. The installer accepts whatever
> directory it's invoked from as its staging source.

## 5. Run the installer

On the VPS:

```bash
sudo bash ~/andybioticlaw/scripts/install.sh
```

This performs all the one-time setup:

- Creates the `andybioticlaw` system user with home `/home/andybioticlaw`.
- Copies the source tree from `/tmp/andybioticlaw` into
  `/home/andybioticlaw/.andybioticlaw/` (hidden dotdir, mode 0700, owned
  by the service user).
- Runs `pnpm install --prod --frozen-lockfile` as the service user so
  `better-sqlite3` and `argon2` compile natively for the VPS's arch.
- Symlinks `/usr/local/bin/andybioticlaw` → the wrapper inside the
  install dir, making the CLI callable by name from any shell.
- Renders the systemd unit from `systemd/andybioticlaw.service.template`
  (substituting the actual install path) and installs + enables it.
- Renders + installs the logrotate config at `/etc/logrotate.d/andybioticlaw`.

Backups are intentionally out of scope — use your VPS provider's
snapshot feature, or your preferred tool (restic, borg, rsync+cron) to
back up `/home/andybioticlaw/.andybioticlaw/data/` off-host. The full
on-disk state is that directory.

It **does not** start the service yet — a few manual steps remain.

> **Custom install dir** (rare): pass `ANDYBIOTICLAW_INSTALL_DIR`
> before the command. Default is `/home/andybioticlaw/.andybioticlaw`.

## 6. Switch to the service user + authenticate the Claude CLI

Subscription credentials live in the service user's home. Open a shell
as that user:

```bash
sudo -iu andybioticlaw
```

Now pick one of the two subscription-auth paths. Both route to the same
subscription billing — NOT pay-as-you-go API credits.

### 6a. Long-lived OAuth token (recommended for unattended servers)

```bash
claude setup-token
```

The CLI prints a token starting with `sk-ant-oat-...` that's valid for
**1 year**. Copy it; paste it into the setup wizard in § 7 (which saves
it to `.env` as `CLAUDE_CODE_OAUTH_TOKEN`). No periodic re-login
required — set once and leave running.

Requires a Pro / Max / Team / Enterprise subscription.

### 6b. Interactive OAuth session

```bash
claude login
```

Follow the OAuth flow: the CLI prints a URL you open in your browser on
any machine (not necessarily the VPS), paste the code back in this SSH
session. Session credentials land in `~/.claude/.credentials.json`
(mode 0600) and auto-refresh on expiry. Every 3-6 months the refresh
token may rotate and you'll need to re-run `claude login` — fine for
personal use, less great for a hands-off deployment.

### Verify either path

```bash
claude auth status --json
# should show:
#   "loggedIn": true,
#   "subscriptionType": "pro" | "max" | "team" | "enterprise"
#   "apiKeySource": "none" (session) OR a CLAUDE_CODE_OAUTH_TOKEN marker (token mode)
# MUST NOT be "ANTHROPIC_API_KEY" — that's pay-as-you-go and the
# service will refuse to boot.
```

The service enforces subscription auth with a reject-list for known API-key
billing sources (see README § Design Decisions). `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` as `apiKeySource` → boot failure. Any other value
paired with a valid `subscriptionType` → accepted (unknown values are
audited as `unknown_api_key_source` for observability).

> **April 2026 caveat**: Anthropic enforces against third-party 24/7
> agents running on subscription credentials (openclaw precedent).
> `setup-token` is not deprecated and both auth paths still work
> technically, but always-on self-hosted operation risks throttling or
> brief account suspension via the abuse classifier. No formal written
> policy, enforcement is heuristic.

## 7. Run the setup menu (still as the service user)

```bash
andybioticlaw
```

Arrow keys + Enter. Select **"Run setup wizard"**. The wizard asks:

- Telegram bot token (from @BotFather)
- Your Telegram numeric user id (from @userinfobot)
- Service timezone (default = VPS system timezone)
- Dashboard password (required when basic-auth is enabled — default;
  press Enter to explicitly disable basic-auth for a localhost-only
  setup)

The wizard writes `.env` + patches `config.yaml` and validates the
result. Re-running is idempotent.

When done, leave the service-user shell:

```bash
exit
```

## 8. Start the service

```bash
sudo systemctl start andybioticlaw
sudo systemctl status andybioticlaw
```

Expected `active (running)`. Tail logs:

```bash
sudo journalctl -u andybioticlaw -f
# or
sudo -u andybioticlaw tail -f /home/andybioticlaw/.andybioticlaw/data/logs/andybioticlaw.log
```

Send a DM to your bot — you should get a reply.

## 9. Back up `data/` (your responsibility)

The service does not ship a built-in backup mechanism. Options, in
increasing order of effort:

- **Hetzner Cloud snapshots** (or your provider's equivalent) — click a
  button, get a whole-disk image. Fine for personal-scale, costs a few
  cents per GB per month.
- **`restic` or `borg` to a different host / S3-compatible bucket** —
  `restic backup /home/andybioticlaw/.andybioticlaw/data` on a cron. Encrypts by default,
  deduplicates, survives VPS loss.
- **`rsync` to another box / NAS** — simplest, no encryption unless you
  wrap it.

The full on-disk state is `/home/andybioticlaw/.andybioticlaw/data/` (SQLite DB, logs,
per-session workspaces). Config + secrets live in
`/home/andybioticlaw/.andybioticlaw/config/config.yaml` and `/home/andybioticlaw/.andybioticlaw/.env`
— back these up separately (they rarely change, but a fresh VPS can't
reconstruct them).

## 10. Expose the dashboard (optional)

The dashboard binds to `127.0.0.1:18790` by default — intentional: not
reachable from the internet. Two ways to access it:

### 10a. SSH tunnel (simplest, most secure)

From your dev machine:

```bash
ssh -L 18790:127.0.0.1:18790 <your-admin-user>@<vps-ip>
# leave this open; open http://localhost:18790/ in your browser
```

### 10b. Reverse proxy with nginx + basic auth (if you want it always-on)

1. Generate an argon2 password hash:

   ```bash
   sudo -u andybioticlaw -H bash -lc \
     "cd /home/andybioticlaw/.andybioticlaw && node -e 'import(\"./dist/dashboard/server.js\").then(async ({hashDashboardPassword}) => console.log(await hashDashboardPassword(\"<your-password>\")))'"
   ```

2. Edit config.yaml:

   ```yaml
   dashboard:
     enabled: true
     host: 127.0.0.1
     port: 18790
     basicAuth:
       enabled: true
       username: admin
       passwordHash: <hash from step 1>
   ```

3. `sudo systemctl restart andybioticlaw` (basicAuth is restart-required).

4. Install nginx + certbot:

   ```bash
   sudo apt-get install -y nginx certbot python3-certbot-nginx
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```

5. Minimal nginx site at `/etc/nginx/sites-available/andybioticlaw`:

   ```nginx
   server {
     server_name dash.example.com;

     location / {
       proxy_pass http://127.0.0.1:18790;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;   # websocket
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }

     listen 80;
   }
   ```

   ```bash
   sudo ln -s /etc/nginx/sites-available/andybioticlaw /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   sudo certbot --nginx -d dash.example.com
   ```

With basic auth at the app layer AND behind HTTPS + (optionally)
IP-allowlist at the nginx layer, this is a reasonable exposure posture
for a personal tool. If you want stricter: put the dashboard behind a
WireGuard endpoint only.

## 11. Future redeploys

The installer is idempotent — re-running it performs an in-place update
of everything except `data/` and `config/config.yaml` (runtime state,
preserved). Pick the path matching your install style:

### 11a. Tarball install (§ 4a path)

```bash
cd ~/andybioticlaw
curl -fsSL -o /tmp/andybioticlaw.tar.gz \
  https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz
tar xzf /tmp/andybioticlaw.tar.gz --strip-components=1
rm /tmp/andybioticlaw.tar.gz

sudo bash scripts/install.sh
sudo systemctl restart andybioticlaw
sudo journalctl -u andybioticlaw -n 50 -f
```

Check [releases](https://github.com/ettisberger/andybioticlaw/releases)
for the version + [CHANGELOG.md](../CHANGELOG.md) for the diff.

### 11b. Git-clone install (§ 4b path)

```bash
cd ~/andybioticlaw
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @andybioticlaw/web build

sudo bash scripts/install.sh     # re-copies source, re-runs pnpm install --prod,
                                  # re-renders + re-installs systemd unit. data/ untouched.
sudo systemctl restart andybioticlaw
sudo journalctl -u andybioticlaw -n 50 -f
```

Or from the service-user shell: `sudo -iu andybioticlaw andybioticlaw
update` does the clone-side steps (git pull + pnpm + build + prune
dev-deps). It stops short of `install.sh` + systemctl because those
need `sudo`, which the service user doesn't have — run them from your
admin user as shown above.

### Common notes

`systemctl restart` performs the graceful shutdown (up to 35 s for
in-flight sessions), then re-boots. The boot-time orphan sweep flips
anything that didn't finish to `orphaned` and notifies you.

> **Build-locally variant:** build on your laptop, `rsync` to
> `~/andybioticlaw/` on the VPS, then run
> `sudo bash ~/andybioticlaw/scripts/install.sh`. Same endpoint.

## Troubleshooting

- **`claude credentials unavailable: apiKeySource=ANTHROPIC_API_KEY`** —
  something in the service's env has `ANTHROPIC_API_KEY` set. Check
  `sudo -u andybioticlaw env | grep ANTHROPIC`, and inspect `.env`.
  The service's env-filter protects sessions, but the startup check
  refuses to green-light API-key billing even so.
- **Dashboard unreachable** — confirm `ss -tln | grep 18790` shows
  `LISTEN` on `127.0.0.1:18790`; confirm your SSH tunnel is open; check
  `dashboard.enabled: true` in config.yaml.
- **Telegram bot unresponsive** — check the token is valid and no other
  instance is polling (`getUpdates` is exclusive).
- **`schedule_auto_disabled`** — a schedule hit the 3-fail-streak or
  loop-rate guard. Check `sqlite3 data/andybioticlaw.db "SELECT detail FROM audit WHERE kind='schedule_auto_disabled' ORDER BY at DESC LIMIT 1;"`
  for the reason; fix the underlying command / prompt; `andybioticlaw
  schedule enable <id>` to re-arm.
