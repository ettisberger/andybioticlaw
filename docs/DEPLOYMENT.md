# Hetzner deployment guide

Target: a bare Hetzner Cloud VPS (x86_64) running Ubuntu 24.04 LTS,
with the service as a dedicated system user and systemd for
supervision. Budget VPS-class (CX11 / CPX11) is fine — the service is
I/O-bound, not CPU-bound.

## 1. Provision the box

Hetzner Cloud → New Server →

- Location: any
- Image: Ubuntu 24.04
- Type: CX22 or CPX11 (1 vCPU, 2 GB RAM is comfortable)
- Networking: IPv4 + IPv6
- SSH key: add yours

SSH in:

```bash
ssh root@<vps-ip>
```

## 2. Harden the base image

```bash
# Non-root admin user (pick whatever username you prefer)
adduser eta --disabled-password --gecos ""
usermod -aG sudo eta
mkdir /home/eta/.ssh
cp ~/.ssh/authorized_keys /home/eta/.ssh/
chown -R eta:eta /home/eta/.ssh
chmod 700 /home/eta/.ssh
chmod 600 /home/eta/.ssh/authorized_keys

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
ssh eta@<vps-ip>    # re-login as the non-root user
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

## 4. Build + rsync the source

On your **dev machine** (not the VPS):

```bash
cd ~/Developer/personal/andybioticlaw
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @andybioticlaw/web build

# Sync everything the VPS needs. Exclude node_modules (native modules
# are arch-specific — we re-install on the VPS) and data/ (runtime state).
rsync -avz --delete \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='.git/' \
  --exclude='.claude/' \
  --exclude='/tmp/' \
  ./ eta@<vps-ip>:/tmp/andybioticlaw-staging/
```

On the **VPS**:

```bash
# Move the staged tree into /opt
sudo mkdir -p /opt/andybioticlaw
sudo rsync -a --delete /tmp/andybioticlaw-staging/ /opt/andybioticlaw/
rm -rf /tmp/andybioticlaw-staging
```

## 5. Run the installer

On the VPS:

```bash
sudo bash /opt/andybioticlaw/scripts/install.sh
```

This performs all the one-time setup:

- Creates the `andybioticlaw` system user with a home dir.
- Sets `/opt/andybioticlaw` ownership + permissions (data/ is 700).
- Runs `pnpm install --prod --frozen-lockfile` as the service user so
  `better-sqlite3` and `argon2` compile for the VPS's arch.
- Symlinks `/opt/andybioticlaw/bin/andybioticlaw` into `/usr/local/bin/`
  so both the principal's shell and the service-user's non-interactive
  subprocess env can invoke the CLI by name.
- Installs + enables the main systemd unit.
- Installs the logrotate config at `/etc/logrotate.d/andybioticlaw`.

Backups are intentionally out of scope — use your VPS provider's
snapshot feature, or your preferred tool (restic, borg, rsync+cron) to
back up `/opt/andybioticlaw/data/` off-host. The full on-disk state is
that directory.

It **does not** start the service yet — a few manual steps remain.

## 6. Log the service user into Claude

Subscription credentials live in the service user's home, so we do this
as `andybioticlaw`:

```bash
sudo -u andybioticlaw -H bash -lc 'claude login'
```

Follow the OAuth flow: the CLI prints a URL you open in your browser on
any machine (not necessarily the VPS), paste the code back in the SSH
session. Verify:

```bash
sudo -u andybioticlaw -H bash -lc 'claude auth status --json'
# should show: "loggedIn": true, "authMethod": "claude.ai",
# "apiKeySource": "none", "subscriptionType": "pro" or "max".
```

The service enforces subscription auth at three layers (see README §
Design Decisions). If `apiKeySource` is anything but `"none"`, the
service will refuse to start sessions.

## 7. Populate config + secrets

```bash
sudo -u andybioticlaw $EDITOR /opt/andybioticlaw/config/config.yaml
```

Edit at least:

- `telegram.dm.allowedUserIds: [<your tg user id>]`
- `service.timezone: <your zone>` (default Europe/Zurich)
- `dashboard.host`: keep `127.0.0.1` unless you're planning a reverse
  proxy (see § 10 below).

```bash
sudo -u andybioticlaw cp /opt/andybioticlaw/.env.example /opt/andybioticlaw/.env
sudo -u andybioticlaw $EDITOR /opt/andybioticlaw/.env
```

Set `TELEGRAM_BOT_TOKEN=<your bot token>`. Leave everything else
commented unless/until a skill needs it.

Validate:

```bash
sudo -u andybioticlaw -H bash -lc 'andybioticlaw config validate'
# OK — config valid: /opt/andybioticlaw/config/config.yaml
```

(`andybioticlaw` resolves to `/usr/local/bin/andybioticlaw`, a symlink
`install.sh` set up during § 5 pointing at
`/opt/andybioticlaw/bin/andybioticlaw`. The wrapper is cwd-independent,
so it works from any directory. If the command is not found, re-run
`sudo bash /opt/andybioticlaw/scripts/install.sh` — the wrapper-link
step is idempotent.)

## 8. Start the service

```bash
sudo systemctl start andybioticlaw
sudo systemctl status andybioticlaw
```

Expected `active (running)`. Tail logs:

```bash
sudo journalctl -u andybioticlaw -f
# or
sudo -u andybioticlaw tail -f /opt/andybioticlaw/data/logs/andybioticlaw.log
```

Send a DM to your bot — you should get a reply.

## 9. Back up `data/` (your responsibility)

The service does not ship a built-in backup mechanism. Options, in
increasing order of effort:

- **Hetzner Cloud snapshots** (or your provider's equivalent) — click a
  button, get a whole-disk image. Fine for personal-scale, costs a few
  cents per GB per month.
- **`restic` or `borg` to a different host / S3-compatible bucket** —
  `restic backup /opt/andybioticlaw/data` on a cron. Encrypts by default,
  deduplicates, survives VPS loss.
- **`rsync` to another box / NAS** — simplest, no encryption unless you
  wrap it.

The full on-disk state is `/opt/andybioticlaw/data/` (SQLite DB, logs,
per-session workspaces). Config + secrets live in
`/opt/andybioticlaw/config/config.yaml` and `/opt/andybioticlaw/.env`
— back these up separately (they rarely change, but a fresh VPS can't
reconstruct them).

## 10. Expose the dashboard (optional)

The dashboard binds to `127.0.0.1:18790` by default — intentional: not
reachable from the internet. Two ways to access it:

### 10a. SSH tunnel (simplest, most secure)

From your dev machine:

```bash
ssh -L 18790:127.0.0.1:18790 eta@<vps-ip>
# leave this open; open http://localhost:18790/ in your browser
```

### 10b. Reverse proxy with nginx + basic auth (if you want it always-on)

1. Generate an argon2 password hash:

   ```bash
   sudo -u andybioticlaw -H bash -lc \
     "cd /opt/andybioticlaw && node -e 'import(\"./dist/dashboard/server.js\").then(async ({hashDashboardPassword}) => console.log(await hashDashboardPassword(\"<your-password>\")))'"
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

To roll a new version:

```bash
# dev machine
git pull
pnpm install
pnpm build
pnpm --filter @andybioticlaw/web build
rsync -avz --delete \
  --exclude='node_modules/' --exclude='data/' --exclude='.git/' --exclude='.claude/' \
  ./ eta@<vps-ip>:/tmp/andybioticlaw-staging/

# VPS
sudo rsync -a --delete /tmp/andybioticlaw-staging/ /opt/andybioticlaw/
sudo -u andybioticlaw -H bash -lc 'cd /opt/andybioticlaw && pnpm install --prod --frozen-lockfile'
sudo systemctl restart andybioticlaw
sudo journalctl -u andybioticlaw -n 50 -f
```

`restart` performs the graceful shutdown (Phase 2: up to 30s for
in-flight sessions), then re-boots. The boot-time orphan sweep flips
anything that didn't finish to `orphaned` and notifies you.

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
