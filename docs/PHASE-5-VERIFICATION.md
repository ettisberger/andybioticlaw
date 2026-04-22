# Phase 5 — manual verification checklist

Covers the Phase 5 done-criteria:
- `http://localhost:18790` — all views navigable.
- Live logs flow via WebSocket.
- Retry button functional (submits a new session).
- Config view masks secrets.
- Queue depth visible per chat.

Prerequisites: earlier phases green, service + bot running.

## Setup

```bash
# Build the frontend into web/dist/ (served by Fastify).
pnpm --filter @andybioticlaw/web build

# Rebuild + (re)start the service.
pnpm build
NODE_ENV=production node dist/index.js
```

Open `http://localhost:18790/`. Expected: Overview page rendered (not
the `{"ok":true,"note":"frontend not built yet"}` placeholder).

For iterative frontend dev you can use Vite's live-reload server
instead:

```bash
# Terminal 1 — backend
pnpm dev

# Terminal 2 — frontend with HMR, proxies /api/* to :18790
pnpm --filter @andybioticlaw/web dev
# open http://localhost:5173/
```

## 1. All eight views render

Click through the sidebar — each should load without an error banner:

- **Overview** — cards for credentials, daily tokens, queue depth,
  installed skills+schedules; lists of recent sessions and recent
  failures.
- **Sessions** — filter chips (All/Running/Completed/Failed/...),
  table with clickable session ids.
- **Session detail** (click a session id) — status/tokens/timing
  cards + message transcript.
- **Schedules** — row per schedule with enable/disable button.
- **Memory** — scope-filtered rows with delete button.
- **Skills** — one row per loaded skill (empty OK if none loaded).
- **Logs** — "● live" badge; lines appear as the service logs.
- **Config** — pretty-printed JSON dump.
- **Audit** — recent audit entries with a kind-filter input.

## 2. Live logs stream via WebSocket

On the Logs page, trigger a SIGHUP on the daemon:

```bash
pnpm exec tsx src/cli/admin.ts config reload
```

You should see within ~1s:

```
HH:MM:SS INFO  received SIGHUP — reloading config
HH:MM:SS INFO  config reload: no changes detected   (or 'N field(s) hot-reloaded')
HH:MM:SS INFO  scheduler refreshed               count=N
```

Scroll up to pause auto-follow; scroll down to resume.

## 3. Retry button (Phase 5 done-criterion)

Get a failed/crashed/orphaned/cancelled session id. If none exists,
produce one quickly:

```bash
# Start a short session, then kill the service mid-flight to force 'orphaned'.
# ...or just use /cancel in Telegram after sending a long prompt.
```

On the **Sessions** page, click `retry` on any non-`completed` row.

- A toast appears: `retry dispatched as <new-session-id>`.
- A new session shows up at the top of the list, same `input_preview`
  as the prior session, status `running` → `completed`.
- In Telegram you see the `…` opening message followed by Emma's reply.
- The audit log (Audit page, filter `prompt_dispatched`) includes a
  `prompt_dispatched` entry with `origin: "dashboard-retry"` and
  `retryOfSessionId: <original>`.

## 4. Config masks secrets

On the **Config** page, search the JSON for `basicAuth`:

```json
"basicAuth": {
  "enabled": false,
  "username": "admin",
  "passwordHash": ""    // empty, because no password set yet
}
```

To verify redaction, set a non-empty hash and reload:

```bash
node -e '
import("./dist/dashboard/server.js").then(async ({ hashDashboardPassword }) => {
  console.log(await hashDashboardPassword("dev-test"));
});
'
# copy output, paste into config/config.yaml under dashboard.basicAuth.passwordHash
# (you can also set enabled: true if you want to verify basic auth)

pnpm exec tsx src/cli/admin.ts config reload
# reload the Config page
# passwordHash should show "[REDACTED]"
```

Restore `passwordHash: ""` and `enabled: false` afterward.

## 5. Queue depth per chat

Send Emma two rapid-fire messages in Telegram:

```
write me a 500 word story
quick, what's 2+2?
```

Switch to the **Overview** page while the first is streaming:

- `Queue depth` card shows `2` with the per-chat breakdown
  (`chat <your-id>: 2`).
- Refresh every 5s (automatic); depth drops as the queue drains.

## 6. Basic auth (optional)

```bash
# 1. Hash a password:
node -e '
import("./dist/dashboard/server.js").then(async ({ hashDashboardPassword }) => {
  console.log(await hashDashboardPassword("<your-password>"));
});
'
# 2. Edit config/config.yaml:
#    dashboard.basicAuth.enabled: true
#    dashboard.basicAuth.passwordHash: <hash from step 1>
# 3. Restart the service (this change is NOT hot-reloadable).
# 4. Visit http://localhost:18790/ — browser prompts for basic auth.
#    Username 'admin' (or whatever you configured), password from step 1.
```

## 7. SPA deep-link works

Visit `http://localhost:18790/schedules` directly (e.g. reload on a
non-root route). The page should load, not 404 — Fastify's SPA fallback
serves `index.html` for any non-`/api/` unmatched route.

## 8. Shutdown

```bash
kill -TERM $(cat data/andybioticlaw.pid)
```

Log: `dashboard listening` stops, then `shutting down`. The pidfile is
removed. `http://localhost:18790/` becomes unreachable.
