import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';
import { loadConfig, projectRoot } from '../config/load.js';
import { defaultConfigPath, defaultEnvPath } from '../config/paths.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';
import { askLine, askSecret } from './prompt-helpers.js';

class InitAbortedError extends Error {
  constructor() {
    super('init aborted by operator');
    this.name = 'InitAbortedError';
  }
}

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

  stdout.write(`\n${bold(lavender('andybioticlaw'))} ${dim('— first-time setup wizard')}\n`);
  stdout.write(dim(`  writes .env and config/config.yaml in ${root}\n`));
  stdout.write(dim(`  safe to re-run; already-set values are reused\n\n`));

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

  try {
    const envExisting = readEnvFile(envPath);
    const envUpdates: Record<string, string> = {};

    // --- 2. Telegram bot token --------------------------------------------
    section(stdout, '1/4', 'Telegram bot token');
    if (envExisting.values.TELEGRAM_BOT_TOKEN) {
      stdout.write(`  ${sage('✓')} ${dim('TELEGRAM_BOT_TOKEN already set in .env — reusing')}\n`);
    } else {
      stdout.write(
        `  ${dim('Get one from')} ${cyan('@BotFather')} ${dim('on Telegram:')}\n` +
          `  ${dim('  1. search @BotFather, /start')}\n` +
          `  ${dim('  2. send /newbot, pick display name + @username')}\n` +
          `  ${dim('  3. copy the token (format: 1234567890:ABC-DEF…)')}\n\n`,
      );
      const token = await askSecret(stdin, stdout, `  ${lavender('?')} bot token: `);
      if (!token) throw new InitAbortedError();
      envUpdates.TELEGRAM_BOT_TOKEN = token;
    }

    // --- 3. Principal user id --------------------------------------------
    section(stdout, '2/4', 'Principal Telegram user id');
    const currentAllowed = readAllowedUserIds(configPath);
    let principalUserId: number | null = null;
    if (currentAllowed.length > 0) {
      stdout.write(
        `  ${sage('✓')} ${dim(`telegram.dm.allowedUserIds already set (${JSON.stringify(currentAllowed)}) — reusing`)}\n`,
      );
    } else {
      stdout.write(
        `  ${dim('DM')} ${cyan('@userinfobot')} ${dim('on Telegram to see your numeric id.')}\n` +
          `  ${dim('Only this user will be allowed to talk to your bot.')}\n\n`,
      );
      while (principalUserId === null) {
        const raw = await askLine(stdin, stdout, `  ${lavender('?')} user id: `);
        if (raw === null) throw new InitAbortedError();
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n <= 0) {
          stdout.write(`  ${yellow('!')} ${dim('must be a positive integer — try again')}\n`);
          continue;
        }
        principalUserId = n;
      }
    }

    // --- 4. Service timezone ---------------------------------------------
    section(stdout, '3/4', 'Service timezone');
    const systemTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich';
    const currentTz = readTimezone(configPath);
    let timezone: string | null = null;
    const currentMatchesExample = currentTz === 'Europe/Zurich';
    if (currentTz && !currentMatchesExample && isValidTimezone(currentTz)) {
      stdout.write(
        `  ${sage('✓')} ${dim(`service.timezone already customised (${currentTz}) — reusing`)}\n`,
      );
    } else {
      stdout.write(
        `  ${dim('Must be a full IANA timezone, e.g.')} ${cyan('Europe/Zurich')}${dim(',')} ${cyan('America/New_York')}${dim('.')}\n` +
          `  ${dim('Press Enter to accept the default detected from this host.')}\n\n`,
      );
      // Loop until the operator gives us a valid IANA zone. An invalid
      // entry (e.g. "zurich" without the "Europe/" prefix) would silently
      // land in config.yaml and crash the service on boot later.
      while (timezone === null) {
        const raw = await askLine(
          stdin,
          stdout,
          `  ${lavender('?')} timezone ${dim(`[default: ${systemTz}]`)}: `,
        );
        if (raw === null) throw new InitAbortedError();
        const candidate = raw.trim() || systemTz;
        if (!isValidTimezone(candidate)) {
          stdout.write(
            `  ${yellow('!')} ${dim(`"${candidate}" is not a valid IANA timezone (need format like Europe/Zurich). Try again.`)}\n`,
          );
          continue;
        }
        timezone = candidate;
      }
    }

    // --- 5. Dashboard password -------------------------------------------
    // Default-on: config.example.yaml ships with basicAuth.enabled: true,
    // so the service boots only if we populate the hash OR explicitly
    // disable auth. Press-Enter path disables auth with a confirmation,
    // so localhost-only quick-try users aren't forced to pick a password.
    section(stdout, '4/4', 'Dashboard basic-auth password');
    const currentHashLine = readPasswordHash(configPath);
    let dashboardPasswordHash: string | null = null;
    let disableDashboardAuth = false;
    if (currentHashLine && currentHashLine.length > 0) {
      stdout.write(
        `  ${sage('✓')} ${dim('dashboard.basicAuth.passwordHash already set — reusing')}\n`,
      );
    } else {
      stdout.write(
        `  ${dim('Dashboard listens on 127.0.0.1:18790 (localhost only). Basic-auth')}\n` +
          `  ${dim('defaults to ON; set a password now, OR press Enter to disable it.')}\n\n`,
      );
      const pwd = await askSecret(
        stdin,
        stdout,
        `  ${lavender('?')} dashboard password: `,
      );
      if (pwd && pwd.length > 0) {
        stdout.write(`  ${dim('hashing with argon2id…')}\n`);
        dashboardPasswordHash = await argon2.hash(pwd, { type: argon2.argon2id });
      } else {
        stdout.write(
          `  ${yellow('!')} ${dim('no password → disabling basic-auth. Re-run init to re-enable.')}\n`,
        );
        disableDashboardAuth = true;
      }
    }

    // --- 6. Write env updates --------------------------------------------
    if (Object.keys(envUpdates).length > 0) {
      writeEnvFileUpdates(envPath, envUpdates);
      stdout.write(
        `\n  ${sage('✓')} ${dim(`wrote ${Object.keys(envUpdates).length} secret(s) to ${envPath}`)}\n`,
      );
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
      // passwordHash lives under `dashboard.basicAuth`. We don't need to
      // flip `enabled: true` — the example ships with it true already; we
      // only flip to false in the opt-out branch below.
      patches.push({
        desc: 'dashboard.basicAuth.passwordHash',
        regex: /^(\s+passwordHash:\s*).*$/m,
        replacement: `$1'${dashboardPasswordHash}'`,
      });
    }
    if (disableDashboardAuth) {
      patches.push({
        desc: 'dashboard.basicAuth.enabled',
        regex: /^(\s+)enabled: true\s*$/m,
        replacement: `$1enabled: false`,
      });
    }

    if (patches.length > 0) {
      let body = readFileSync(configPath, 'utf8');
      for (const p of patches) {
        const before = body;
        body = body.replace(p.regex, p.replacement);
        if (body === before) {
          stdout.write(
            `  ${yellow('!')} ${dim(`could not patch ${p.desc} — no matching line, edit manually`)}\n`,
          );
        } else {
          stdout.write(`  ${sage('✓')} ${dim(`patched ${p.desc} in config.yaml`)}\n`);
        }
      }
      writeFileSync(configPath, body);
    }
  } finally {
    // No readline interface to close — we drove everything through
    // raw-mode `askLine` / `askSecret` which clean up after themselves.
    (stdin as unknown as { pause?: () => void }).pause?.();
  }

  // --- 8. Validate the result ------------------------------------------
  stdout.write('\n');
  try {
    const result = loadConfig();
    stdout.write(`  ${sage('✓')} ${green('config valid:')} ${dim(result.configPath)}\n`);
    stdout.write(
      `    ${dim(`agent=${result.config.agent.name}  model=${result.config.agent.model}  tz=${result.config.service.timezone}`)}\n`,
    );
  } catch (e) {
    stdout.write(`  ${yellow('⚠')} config validation failed: ${(e as Error).message}\n`);
    stdout.write(
      `    ${dim(`edit ${configPath} manually and re-run 'andybioticlaw config validate'`)}\n`,
    );
  }

  // --- 9. Next steps ---------------------------------------------------
  // Detect whether we're running as the dedicated service user. On the
  // production install (user `andybioticlaw` via `sudo -iu …`) → surface
  // systemctl. On a dev machine (most likely `eta`/`root`/anything else)
  // → surface `pnpm dev`. This keeps the message unambiguous instead of
  // showing both options and confusing the operator.
  const isServiceUser = process.env.USER === 'andybioticlaw';
  stdout.write(
    `\n${bold('Next steps')}\n` +
      `  ${lavender('1.')} Log into Claude (if you haven't):  ${cyan('claude login')}\n` +
      `     ${dim('Verify with:  claude auth status --json')}\n`,
  );
  if (isServiceUser) {
    stdout.write(
      `  ${lavender('2.')} Exit this shell, then start the service:\n` +
        `     ${cyan('exit')}\n` +
        `     ${cyan('sudo systemctl start andybioticlaw')}\n` +
        `     ${cyan('sudo journalctl -u andybioticlaw -f')}\n`,
    );
  } else {
    stdout.write(
      `  ${lavender('2.')} Start the service (from the project root):\n` +
        `     ${dim('# dev (watch mode):')}  ${cyan('pnpm dev')}\n` +
        `     ${dim('# prod (systemd):')}   ${cyan('sudo systemctl start andybioticlaw')}\n`,
    );
  }
  stdout.write(
    `  ${lavender('3.')} DM your bot on Telegram to confirm it answers.\n` +
      `  ${lavender('4.')} Back up data/ yourself — see docs/DEPLOYMENT.md § 9.\n\n` +
      `${dim('made by')} ${green('cognitek.dev')}\n\n`,
  );
}

/** Prints a section header like `── 2/4 · Principal user id ──`. */
function section(stdout: NodeJS.WritableStream, step: string, title: string): void {
  stdout.write(`\n${dim('──')} ${lavender(step)} ${dim('·')} ${bold(title)} ${dim('──')}\n\n`);
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

/**
 * Validate that `tz` is an IANA timezone the ICU can actually parse.
 * node-cron + our scheduler use `new Intl.DateTimeFormat(locale, { timeZone })`
 * at runtime — a bad value there crashes the service on boot, so we
 * reject early and make the operator re-enter.
 */
function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// askLine / askSecret are imported from `./prompt-helpers` so the same
// raw-mode flow is shared with edit-config and any future interactive
// CLI flow.
