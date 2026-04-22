import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';
import { loadConfig, projectRoot } from '../config/load.js';
import { defaultConfigPath, defaultEnvPath } from '../config/paths.js';

/**
 * `andybioticlaw init` — first-time setup wizard.
 *
 * Intended to run once on a fresh VPS (or dev machine) right after
 * `install.sh`. Populates `.env` and `config.yaml` interactively with the
 * four values a brand-new install can't guess:
 *
 *   1. Telegram bot token (from @BotFather)
 *   2. Principal's numeric Telegram user id (from @userinfobot)
 *   3. Service timezone (defaulted from the host)
 *   4. Optional dashboard basic-auth password (argon2-hashed into config)
 *
 * Idempotent: re-running skips fields that are already set. Secrets go
 * into `.env` (0600). Non-secret config lines are patched surgically in
 * `config.yaml` via line-oriented regex so comments and unrelated
 * formatting survive. Fields this wizard does not touch stay as they
 * were in `config.example.yaml`; the user edits by hand for anything
 * beyond the core four.
 */

export async function runInitCommand(): Promise<void> {
  const root = projectRoot();
  const envPath = defaultEnvPath(root);
  const configPath = defaultConfigPath(root);
  const envExample = resolve(root, '.env.example');
  const configExample = resolve(root, 'config', 'config.example.yaml');

  const stdin = process.stdin as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void;
  };
  const stdout = process.stdout;

  stdout.write(`\nandybioticlaw — first-time setup wizard\n`);
  stdout.write(`This writes .env and config/config.yaml in ${root}.\n`);
  stdout.write(`Re-running is safe; already-set values are reused.\n\n`);

  // --- 1. Ensure example files have been copied into editable ones -------
  if (!existsSync(envPath)) {
    if (!existsSync(envExample)) {
      throw new Error(`neither ${envPath} nor ${envExample} exists — cannot bootstrap`);
    }
    copyFileSync(envExample, envPath);
    try {
      chmodSync(envPath, 0o600);
    } catch {
      /* non-fatal */
    }
    stdout.write(`✓ created ${envPath} from .env.example\n`);
  }
  if (!existsSync(configPath)) {
    if (!existsSync(configExample)) {
      throw new Error(`neither ${configPath} nor ${configExample} exists — cannot bootstrap`);
    }
    copyFileSync(configExample, configPath);
    stdout.write(`✓ created ${configPath} from config.example.yaml\n`);
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  try {
    const envExisting = readEnvFile(envPath);
    const envUpdates: Record<string, string> = {};

    // --- 2. Telegram bot token --------------------------------------------
    if (envExisting.values.TELEGRAM_BOT_TOKEN) {
      stdout.write(`\n✓ TELEGRAM_BOT_TOKEN already set in .env (reusing)\n`);
    } else {
      stdout.write(
        `\nYour Telegram bot needs a token from @BotFather.\n` +
          `  1. Open Telegram, search for @BotFather, /start.\n` +
          `  2. Send /newbot, pick a display name and a @username.\n` +
          `  3. Copy the token (format: 1234567890:ABC-DEF...).\n`,
      );
      const token = await askSecret(stdin, stdout, '  ? TELEGRAM_BOT_TOKEN: ');
      if (!token) throw new Error('bot token is required');
      envUpdates.TELEGRAM_BOT_TOKEN = token;
    }

    // --- 3. Principal user id --------------------------------------------
    const currentAllowed = readAllowedUserIds(configPath);
    let principalUserId: number | null = null;
    if (currentAllowed.length > 0) {
      stdout.write(
        `\n✓ telegram.dm.allowedUserIds already set in config.yaml (${JSON.stringify(currentAllowed)}) — reusing\n`,
      );
    } else {
      stdout.write(
        `\nWho is allowed to DM this bot? Message @userinfobot on Telegram\n` +
          `to see your own numeric id. Enter only yours for now.\n`,
      );
      while (principalUserId === null) {
        const raw = await askLine(rl, '  ? principal Telegram user id: ');
        const n = Number(raw?.trim());
        if (!Number.isInteger(n) || n <= 0) {
          stdout.write(`  ! must be a positive integer. Try again.\n`);
          continue;
        }
        principalUserId = n;
      }
    }

    // --- 4. Service timezone ---------------------------------------------
    const systemTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich';
    const currentTz = readTimezone(configPath);
    let timezone: string | null = null;
    const currentMatchesExample = currentTz === 'Europe/Zurich';
    if (currentTz && !currentMatchesExample) {
      stdout.write(
        `\n✓ service.timezone already customised (${currentTz}) — reusing\n`,
      );
    } else {
      const prompt = `\n  ? service timezone [${systemTz}]: `;
      const raw = await askLine(rl, prompt);
      timezone = raw?.trim() || systemTz;
    }

    // --- 5. Optional dashboard password ----------------------------------
    const currentHashLine = readPasswordHash(configPath);
    let dashboardPasswordHash: string | null = null;
    let enableDashboardAuth = false;
    if (currentHashLine && currentHashLine.length > 0) {
      stdout.write(
        `\n✓ dashboard.basicAuth.passwordHash already set — reusing\n`,
      );
    } else {
      stdout.write(
        `\nDashboard lives on 127.0.0.1:18790 by default (localhost only).\n` +
          `If you will expose it via nginx later, set a password now; otherwise\n` +
          `leave empty to skip.\n`,
      );
      const pwd = await askSecret(
        stdin,
        stdout,
        '  ? dashboard password (empty to skip): ',
      );
      if (pwd && pwd.length > 0) {
        stdout.write(`  hashing password with argon2id…\n`);
        dashboardPasswordHash = await argon2.hash(pwd, { type: argon2.argon2id });
        enableDashboardAuth = true;
      }
    }

    // --- 6. Write env updates --------------------------------------------
    if (Object.keys(envUpdates).length > 0) {
      writeEnvFileUpdates(envPath, envUpdates);
      stdout.write(`✓ wrote ${Object.keys(envUpdates).length} secret(s) to ${envPath}\n`);
    }

    // --- 7. Patch config.yaml (line-oriented, preserves comments) --------
    const patches: Array<{ desc: string; regex: RegExp; replacement: string }> = [];
    if (principalUserId !== null) {
      patches.push({
        desc: 'telegram.dm.allowedUserIds',
        regex: /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
        replacement: `$1[${principalUserId}]`,
      });
    }
    if (timezone !== null) {
      patches.push({
        desc: 'service.timezone',
        regex: /^(\s+timezone:\s*).*$/m,
        replacement: `$1${timezone}`,
      });
    }
    if (dashboardPasswordHash !== null) {
      // passwordHash and enabled live under `dashboard.basicAuth`.
      patches.push({
        desc: 'dashboard.basicAuth.passwordHash',
        regex: /^(\s+passwordHash:\s*).*$/m,
        replacement: `$1'${dashboardPasswordHash}'`,
      });
      if (enableDashboardAuth) {
        patches.push({
          desc: 'dashboard.basicAuth.enabled',
          regex: /^(\s+)enabled: false\s*$/m,
          replacement: `$1enabled: true`,
        });
      }
    }

    if (patches.length > 0) {
      let body = readFileSync(configPath, 'utf8');
      for (const p of patches) {
        const before = body;
        body = body.replace(p.regex, p.replacement);
        if (body === before) {
          stdout.write(
            `  ! could not patch ${p.desc} — no matching line in config.yaml. Edit manually.\n`,
          );
        } else {
          stdout.write(`✓ patched ${p.desc} in config.yaml\n`);
        }
      }
      writeFileSync(configPath, body);
    }
  } finally {
    rl.close();
  }

  // --- 8. Validate the result ------------------------------------------
  try {
    const result = loadConfig();
    stdout.write(`\n✓ config valid: ${result.configPath}\n`);
    stdout.write(
      `  agent=${result.config.agent.name} model=${result.config.agent.model} tz=${result.config.service.timezone}\n`,
    );
  } catch (e) {
    stdout.write(`\n⚠️  config validation failed: ${(e as Error).message}\n`);
    stdout.write(
      `  Edit ${configPath} manually and re-run 'andybioticlaw config validate'.\n`,
    );
  }

  // --- 9. Next steps ---------------------------------------------------
  stdout.write(
    `\nNext steps\n` +
      `  1. Log the service user (or yourself, in dev) into Claude:\n` +
      `       claude login\n` +
      `     Follow the OAuth flow; verify with 'claude auth status --json'.\n` +
      `  2. Start the service:\n` +
      `     - systemd (prod): sudo systemctl start andybioticlaw\n` +
      `     - local dev:       pnpm dev\n` +
      `  3. DM your bot on Telegram to confirm it answers.\n` +
      `  4. Arrange backups for 'data/' yourself — see docs/DEPLOYMENT.md § 9.\n\n`,
  );
}

// --- config.yaml line readers -----------------------------------------

function readAllowedUserIds(configPath: string): number[] {
  const body = readFileSync(configPath, 'utf8');
  const m = body.match(/^\s+allowedUserIds:\s*\[(.*?)\]/m);
  if (!m || m[1] === undefined) return [];
  const inside = m[1].trim();
  if (!inside) return [];
  return inside
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function readTimezone(configPath: string): string {
  const body = readFileSync(configPath, 'utf8');
  const m = body.match(/^\s+timezone:\s*(\S+)\s*$/m);
  return m && m[1] !== undefined ? m[1] : '';
}

function readPasswordHash(configPath: string): string {
  const body = readFileSync(configPath, 'utf8');
  const m = body.match(/^\s+passwordHash:\s*['"]?([^'"\s]*)['"]?\s*$/m);
  return m && m[1] !== undefined ? m[1] : '';
}

// --- readline helpers -------------------------------------------------

function askLine(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => resolve(ans));
    rl.once('close', () => resolve(null));
  });
}

async function askSecret(
  stdin: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void },
  stdout: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  stdout.write(prompt);
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      for (const char of s) {
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\x03') {
          cleanup();
          stdout.write('\n');
          resolve(null);
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char.charCodeAt(0) < 0x20) continue;
        input += char;
        stdout.write('*');
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause?.();
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    (stdin as unknown as { resume?: () => void }).resume?.();
    stdin.on('data', onData);
  });
}
