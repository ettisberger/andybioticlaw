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

## 4. Clone + build the source

Clone into your admin user's home (**not `/tmp`** — you want this
persistent so future redeploys are a simple `git pull` + rebuild):

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
home dotdir; your staging clone remains intact for future updates.

> **Dev-machine variant:** if you prefer not to install build-tools on
> the VPS, build locally and rsync:
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

## 6. Switch to the service user + log into Claude

Subscription credentials live in the service user's home. Open a shell
as that user and run `claude login` there:

```bash
sudo -iu andybioticlaw
claude login
```

Follow the OAuth flow: the CLI prints a URL you open in your browser on
any machine (not necessarily the VPS), paste the code back in this SSH
session. Verify:

```bash
claude auth status --json
# should show: "loggedIn": true, "authMethod": "claude.ai",
# "apiKeySource": "none", "subscriptionType": "pro" or "max".
```

The service enforces subscription auth at three layers (see README §
Design Decisions). If `apiKeySource` is anything but `"none"`, the
service will refuse to start sessions.

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
ssh -L 18790:127.0.0.1:18790 eta@<vps-ip>
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
of everything except `data/` (runtime state, preserved):

```bash
# On the VPS, in your ~/andybioticlaw clone (from § 4):
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

`restart` performs the graceful shutdown (up to 35s for in-flight
sessions), then re-boots. The boot-time orphan sweep flips anything
that didn't finish to `orphaned` and notifies you.

> **Dev-machine variant:** build locally, `rsync` to `~/andybioticlaw/`
> on the VPS, then run `sudo bash ~/andybioticlaw/scripts/install.sh`.
> Same endpoint.

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
