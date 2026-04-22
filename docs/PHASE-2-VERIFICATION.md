# Phase 2 — manual verification checklist

These steps verify the Phase 2 done-criteria from the brief. They require a
real Telegram bot token and a Claude subscription active on this machine.
Most steps assume you are the only user in `telegram.dm.allowedUserIds`.

## Setup

```bash
# 1. Install / build
pnpm install
pnpm build

# 2. Populate secrets
$EDITOR .env
# TELEGRAM_BOT_TOKEN=...

# 3. Set your Telegram user id in config/config.yaml
$EDITOR config/config.yaml
# telegram:
#   dm:
#     allowedUserIds: [<your tg user id>]

# 4. Run
pnpm dev
# or for prod-style:
NODE_ENV=production node dist/index.js
```

Expected boot log (in addition to Phase 1 lines):

```
INFO  telegram bot polling started
INFO  ready
```

## 1. Happy path — single message streamed and persisted

Send **"Say hi in two sentences, no more."** to the bot.

- Bot replies immediately with `⏳ Working…`, then edits the message in place
  every ~1.2s with `✍️` suffix, and finalizes with no suffix.
- `sqlite3 data/andybioticlaw.db 'SELECT id,status,tokens_input,tokens_output FROM sessions ORDER BY started_at DESC LIMIT 1'`
  shows status `completed` with non-zero token counts.
- `SELECT role, substr(content,1,60) FROM messages ORDER BY id DESC LIMIT 2`
  shows one `assistant` row (the final text) and one `user` row.

## 2. Conversation context

Send **"What did I just ask you?"** as a follow-up.

- The bot's reply references the prior message (e.g. "You asked me to say hi…"),
  proving that conversation history is being rebuilt from the DB.
- Stop the service, run `sqlite3 data/andybioticlaw.db 'SELECT session_id, role, substr(content,1,60) FROM messages'`;
  note there are 4 messages across 2 sessions, chronologically interleaved.

## 3. Sequential queue

Send **"write me a 500 word poem"** and immediately (within 1s) send
**"what time is it?"**.

- The first message gets `⏳ Working…` and begins streaming.
- The second gets `⏳ Queued (position 2)…`.
- When the first finishes, the second's message edits to `⏳ Working…` and
  starts streaming.
- Dashboard `/status` during this interval (or just `/status` in Telegram)
  shows the queue depth in the heartbeat JSON:
  ```
  SELECT meta FROM heartbeats ORDER BY at DESC LIMIT 1;
  # {"active_sessions":2,"queue_depths":{"<chat>":2}}
  ```

## 4. Orphan recovery on kill

While a long-running session (from step 3's poem prompt) is streaming:

```bash
# in another terminal:
kill -9 $(cat data/andybioticlaw.pid)
```

- Telegram message freezes with the partial output.
- Restart: `pnpm dev` (or `node dist/index.js`).
- Boot log contains `marked N interrupted session(s) as orphaned`.
- You receive a single DM: `ℹ️ Service restarted. 1 session(s) interrupted. You can /retry them once re-identified in the dashboard.`
- `SELECT status, error FROM sessions WHERE status='orphaned' ORDER BY started_at DESC LIMIT 1;`
  shows `orphaned / service restarted mid-session`.

## 5. /retry

Find the session id of the orphaned (or any failed) session:

```bash
sqlite3 data/andybioticlaw.db "SELECT id, status, substr(input_preview,1,40) FROM sessions ORDER BY started_at DESC LIMIT 5;"
```

In Telegram: `/retry <session-id>`.

- Bot submits a new session with the original user input.
- Old session row stays as-is (still `orphaned`/`failed`).
- New session appears with status `running` then `completed`.

## 6. Daily budget gate

Edit `config/config.yaml`:

```yaml
budget:
  dailyTokenLimit: 50        # tiny, easy to exhaust
```

`pnpm exec tsx src/cli/admin.ts config reload` (or restart). Send a message —
the reply is consumed, usage exceeds 50 tokens instantly, and the NEXT message
is rejected with:

```
⛔ Daily token budget exhausted (X / 50 tokens). Window resets at YYYY-MM-DD HH:MM:00 (Europe/Zurich).
```

The audit log has a `budget_exceeded` row:

```bash
sqlite3 data/andybioticlaw.db "SELECT kind, detail FROM audit WHERE kind='budget_exceeded' ORDER BY at DESC LIMIT 3;"
```

Restore `dailyTokenLimit` to its real value and reload.

## 7. /cancel

Send **"write 1000 words about Swiss mountains"**. While it streams, send `/cancel`.

- Bot replies with `⏹ cancelled running session.` (and a count of dropped
  queued messages if any).
- The Telegram message is finalized with `⏹ Cancelled.` prepended.
- `SELECT status FROM sessions ORDER BY started_at DESC LIMIT 1;` shows
  `cancelled`.

## 8. Graceful shutdown while session in-flight

Send a long-generation prompt. Quickly run:

```bash
kill -TERM $(cat data/andybioticlaw.pid)
```

- Shutdown log: `shutting down (signal: SIGTERM)`, then the session
  streams to completion (within the 30s budget), THEN the process exits.
- DB shows status `completed` for that session.
- If the session exceeds 30 s, it's left for the next-boot orphan sweep.

## 9. Non-authorized DM rejection

From a different Telegram account (not in `allowedUserIds`), send any message.

- Reply is `🚫 Not authorized.`.
- Audit row: `kind='unauthorized_access', actor='tg:<user-id>', detail={scope:'dm'}`.

## 10. Group chat rejection

Add the bot to a group and send a message.

- Reply is `🚫 Group chats are not supported in this version. DM me instead.`.
- Audit row: `kind='unauthorized_access', actor='tg:group:<chat-id>',
  detail={scope:'group', reason:'groups rejected in v1'}`.
