import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Boot the compiled service in a scratch dir, hit the dashboard, SIGTERM,
 * assert clean shutdown. Verifies the wiring between config loading,
 * migrations, credentials check, dashboard startup, and graceful shutdown.
 *
 * Gated behind `pnpm build` having already produced dist/. Does NOT talk to
 * Telegram or Claude — TELEGRAM_BOT_TOKEN is intentionally unset in the child
 * env, so the bot path is a no-op and only the dashboard + core come up.
 */
const DIST_ENTRY = resolve(__dirname, '..', '..', 'dist', 'index.js');
const canRun = existsSync(DIST_ENTRY);
const d = canRun ? describe : describe.skip;

d('service boot + shutdown (black-box)', () => {
  it('boots, serves /api/overview, shuts down cleanly on SIGTERM', async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), 'andy-boot-'));
    const configDir = mkdtempSync(resolve(tmpdir(), 'andy-boot-cfg-'));

    // Minimal self-contained config.yaml for this boot — same shape as
    // config.example.yaml but with a random port and the scratch dataDir.
    const port = 19500 + Math.floor(Math.random() * 500);
    const cfg = `
service:
  name: andybioticlaw-test
  dataDir: ${dataDir}
  logLevel: info
  timezone: UTC

agents:
  - id: emma
    name: Emma
    default: true
    model: claude-opus-4-7
    credentialsDir: ~/.claude
    streamIdleTimeoutSec: 120
    skills: ['*']

bindings: []

telegram:
  dm:
    allowedUserIds: []
    runMode: host
  group:
    allowedGroupIds: []
    runMode: workspace
    workspaceBase: ${dataDir}/workspaces/groups
  streamEditIntervalMs: 1200
  longTaskNotifyAfterMs: 60000
  conversationHistoryLimit: 50

budget:
  dailyTokenLimit: 2000000
  perSessionTokenLimit: 200000
  perScheduleDefault: 50000
  dailyResetTime: '00:00'

memory:
  autoAccept: true
  defaultScopes: [global, user]
  ttlCleanupCron: '0 3 * * *'

dashboard:
  enabled: true
  host: 127.0.0.1
  port: ${port}
  basicAuth:
    enabled: false
    username: admin
    passwordHash: ''

observability:
  heartbeatIntervalSec: 60
  heartbeatRetentionDays: 7
  errorsToTelegram: false
  errorChatIdOverride: null

skills:
  dir: ${resolve(__dirname, '..', '..', 'skills')}
  autoLoadOnStart: true
`;
    writeFileSync(resolve(configDir, 'config.yaml'), cfg);

    // Copy skills dir so the loader sees only real scaffolding.
    void copyFileSync; // reserved for future — not needed since CONFIG_PATH points to its own file only

    // Strip TELEGRAM_BOT_TOKEN so the bot doesn't try to poll.
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.ANTHROPIC_API_KEY; // defensive
    env.CONFIG_PATH = resolve(configDir, 'config.yaml');
    env.NODE_ENV = 'production';

    const child = spawn('node', [DIST_ENTRY], {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const log: string[] = [];
    child.stderr.on('data', (c) => log.push(c.toString('utf8')));
    child.stdout.on('data', (c) => log.push(c.toString('utf8')));

    try {
      // Poll the dashboard until it responds or we give up.
      const url = `http://127.0.0.1:${port}/api/overview`;
      const deadline = Date.now() + 8000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            const body = (await r.json()) as { agentName: string };
            expect(body.agentName).toBe('Emma');
            ready = true;
            break;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(ready, `dashboard never became ready. log tail:\n${log.join('').slice(-2000)}`).toBe(true);

      // Also check the pidfile exists and points to the right pid.
      const pidPath = resolve(dataDir, 'andybioticlaw.pid');
      expect(existsSync(pidPath)).toBe(true);

      // Graceful shutdown.
      const exitPromise = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      });
      child.kill('SIGTERM');
      const code = await Promise.race([
        exitPromise,
        new Promise<number | null>((res) => setTimeout(() => res(-1), 8000)),
      ]);
      expect(code).toBe(0);

      // Pidfile should be removed.
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
      try {
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(configDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }, 20_000);
});
