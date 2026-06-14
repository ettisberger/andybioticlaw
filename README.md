# andybioticlaw

A single-operator, self-hosted AI agent. Telegram on the front, the Claude CLI on the back, one SQLite file, one systemd unit. The default agent identity is **Emma**; the service is **andybioticlaw**.

## What you get

- A Telegram bot that talks to you, remembers things across sessions, and can run scheduled tasks.
- A local web dashboard (sessions, memory, schedules, skills, logs, config).
- One Linux process, one SQLite DB, no Docker, no cloud.

## Requirements

- A Linux server (any VPS — tested on Ubuntu 24.04). 1 vCPU + 2 GB RAM is comfortable.
- Node.js 20 LTS or newer.
- The `claude` CLI authenticated against a Claude **Pro/Max/Team/Enterprise subscription** — the service refuses to start on pay-as-you-go API-key billing.
- A Telegram bot token ([@BotFather](https://t.me/BotFather)) and your Telegram user id ([@userinfobot](https://t.me/userinfobot)).

## Install

```bash
# 1. System dependencies (Ubuntu/Debian — adjust apt for other distros)
sudo apt-get update
sudo apt-get install -y curl ca-certificates sqlite3 logrotate rsync git \
  build-essential python3 python3-dev
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable pnpm

# 2. Download + extract the latest release
mkdir -p ~/andybioticlaw && cd ~/andybioticlaw
curl -fsSL https://github.com/ettisberger/andybioticlaw/releases/latest/download/andybioticlaw.tar.gz \
  | tar xz --strip-components=1

# 3. Install (creates the `andybioticlaw` system user + systemd unit + logrotate)
sudo bash scripts/install.sh

# 4. As the service user: install + authenticate Claude, then run the setup wizard
sudo -iu andybioticlaw
curl -fsSL https://claude.ai/install.sh | bash   # installs into ~/.local/bin
claude setup-token      # long-lived OAuth token, recommended — paste into wizard step 5
                        #   (or `claude login` for interactive session auth)
andybioticlaw           # interactive menu → "Run setup wizard"
exit

# 5. Start + verify
sudo systemctl start andybioticlaw
sudo -u andybioticlaw andybioticlaw doctor   # expect all-✓
sudo journalctl -u andybioticlaw -f
```

DM your bot — it replies.

See **[docs/QUICKSTART.md](docs/QUICKSTART.md)** for the full walkthrough and **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for production hardening (SSH, UFW, TLS reverse-proxy, backups).

## Update

```bash
sudo -iu andybioticlaw
andybioticlaw update         # auto-detects tarball vs git-clone install
exit
sudo systemctl restart andybioticlaw
```

Your `config/config.yaml`, `.env`, and `data/` are preserved.

## Uninstall

```bash
sudo systemctl stop andybioticlaw
sudo systemctl disable andybioticlaw
sudo rm /etc/systemd/system/andybioticlaw.service
sudo rm -rf /etc/systemd/system/andybioticlaw.service.d
sudo rm /etc/logrotate.d/andybioticlaw /usr/local/bin/andybioticlaw
sudo userdel --remove andybioticlaw    # optional — destroys data
```

## Configuration

- `config/config.yaml` — runtime config. Schema in `config/config.schema.ts` (Zod).
- `.env` — secrets (`TELEGRAM_BOT_TOKEN`, optionally `CLAUDE_CODE_OAUTH_TOKEN`). Mode 0600.
- Edit interactively: `andybioticlaw config edit` (or pick "Edit settings" from the menu).
- Hot-reloadable fields: `SIGHUP` or `andybioticlaw config reload` re-reads without restarting.

### Optional dashboard pages

- **Projects** — set `projects.enabled: true` in `config.yaml` to surface a workspace overview at `/projects`. Scans `projects.folderPath` (default `~/projects`) and shows branch, last commit, dirty state, and an activity badge per repo. Read-only; no deploy or container logic. Requires `git` on PATH.
- **Browser** — set `browser.enabled: true` plus install the `browser` skill to give Emma a real headless Chromium via Playwright. Install in two steps: as your operator user `sudo $(andybioticlaw skill apt-deps browser)` to install Chromium's system packages, then as the service user `sudo -iu andybioticlaw andybioticlaw skill install browser`. Snapshot/ref API drives navigate / click / type / submit / screenshot. Per-named-profile user-data-dirs (`data/browser/profiles/<name>/`) keep logged-in identities isolated and persistent across restarts; a hostname allowlist (`browser.hostnameAllowlist`, IDN-homoglyph-safe via punycode) is the SSRF guard. Initial login happens on the operator's laptop via `scripts/browser-login.mjs` and uploads `storageState.json` to the dashboard's gated import endpoint (basic-auth required, one-shot import window, audit-logged). The `/browser` page shows a per-session timeline with screenshot thumbnails; retention cron prunes old rows + files daily.

## Dev setup (contributors)

```bash
git clone https://github.com/ettisberger/andybioticlaw.git
cd andybioticlaw
./scripts/bootstrap-dev.sh       # install deps + copy example configs
pnpm dev                         # watch-mode service
```

Useful commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm -r build`.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the commit-message convention (required — release notes are auto-generated).

## Documentation

| File | What's in it |
|---|---|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Fresh VPS → bot answering DMs, step by step |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production hardening: SSH, UFW, TLS, backups |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, secret scoping, incident response |
| [docs/DESIGN.md](docs/DESIGN.md) | Non-obvious architectural decisions + rationale |
| [CHANGELOG.md](CHANGELOG.md) | Per-release changes (auto-generated from conventional commits) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, commit conventions, PR guide |
| [skills/README.md](skills/README.md) | Skill contract: manifest, secrets, lifecycle |

## Security posture (short version)

- The config file, `.env`, and skills dir ARE the trust boundary. Whoever can edit them runs shell as the service user.
- `bash` schedule payloads run as the service user — treat them like any cron job.
- Subscription auth is enforced at three layers; pay-as-you-go API-key billing is hard-blocked.
- Dashboard defaults to `127.0.0.1:18790`. If you expose it publicly, add TLS + basic-auth + network allowlist. See DEPLOYMENT.md § 10.

Full posture: [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
