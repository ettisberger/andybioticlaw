import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../config/load.js';
import { defaultConfigPath, defaultEnvPath } from '../config/paths.js';
import {
  bold,
  clearScreen,
  cyan,
  dim,
  enterAltScreen,
  exitAltScreen,
  green,
  hideCursor,
  lavender,
  pink,
  sage,
  showCursor,
} from './ansi.js';

/**
 * Interactive TUI menu shown when `andybioticlaw` is invoked with no
 * subcommand. Colored greeting, version, menu entries, footer.
 * Arrow-key (↑/↓) + Enter navigation; `q` or Ctrl-C exits.
 *
 * Menu state is evaluated at startup: if `.env` carries a non-empty
 * TELEGRAM_BOT_TOKEN AND `config.yaml` has a non-empty allowedUserIds,
 * the operator has already run setup — we adjust the labels accordingly.
 * Fully-featured extra actions (status / logs / restart) are hooks for
 * later — v1 ships with setup-or-re-setup only.
 */
export async function runInteractiveMenu(): Promise<void> {
  const version = readCoreVersion();

  try {
    while (true) {
      // Recompute each iteration — after `Run setup wizard` finishes the
      // first time, `setupDone` flips and the menu grows new entries.
      const setupDone = detectSetupDone();

      const items: Array<{
        label: string;
        quit?: boolean;
        handler: () => Promise<void>;
      }> = [
        {
          label: setupDone
            ? 'Re-run setup wizard (safe, idempotent)'
            : 'Run setup wizard — Telegram bot token, principal id, timezone',
          handler: async () => {
            const { runInitCommand } = await import('./init.js');
            await runInitCommand();
          },
        },
      ];
      if (setupDone) {
        items.push({
          label: 'Settings — model, budget, dashboard, voice, …',
          handler: async () => {
            const { runSettingsCommand } = await import('./settings/run.js');
            await runSettingsCommand();
          },
        });
        items.push({
          label: 'Skills — install-wizard + per-skill secrets',
          handler: async () => {
            const { runSkillMenuCommand } = await import('./skill-menu.js');
            await runSkillMenuCommand();
          },
        });
        items.push({
          label: 'Update — git pull + rebuild + prune dev deps',
          handler: async () => {
            const { runUpdateCommand } = await import('./update.js');
            await runUpdateCommand();
          },
        });
      }
      items.push({
        label: 'Quit',
        quit: true,
        handler: async () => {
          /* no-op — handled by the loop */
        },
      });

      const selected = await pickItem(items, version, setupDone);
      if (selected < 0) return; // Ctrl-C / q — exit the loop entirely.
      const chosen = items[selected];
      if (!chosen || chosen.quit) return;
      // Newline between menu and wizard output looks cleaner.
      process.stdout.write('\n');
      await chosen.handler();
      // Back to the top-level menu for another pick.
    }
  } finally {
    // Without this the process stays alive: pickItem called
    // stdin.resume() and never paused it, so node's event loop keeps
    // waiting on an empty TTY. Pause now so `andybioticlaw` actually
    // exits when the menu is dismissed.
    if (typeof (process.stdin as { pause?: () => void }).pause === 'function') {
      process.stdin.pause();
    }
  }
}

/**
 * Render the menu once, read one arrow/enter cycle at a time until the
 * user picks something. Returns the item index, or -1 on q / Ctrl-C.
 */
async function pickItem(
  items: Array<{ label: string }>,
  version: string,
  setupDone: boolean,
): Promise<number> {
  const stdin = process.stdin as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void;
  };
  let index = 0;

  function redraw(): void {
    clearScreen();
    process.stdout.write('\n');
    process.stdout.write(`  ${bold(lavender('andybioticlaw'))}  ${dim(`v${version}`)}\n`);
    process.stdout.write(
      `  ${dim('personal AI agent service · Telegram + Claude CLI')}\n`,
    );
    process.stdout.write('\n');
    const status = setupDone
      ? sage('● setup complete')
      : cyan('○ setup not yet run');
    process.stdout.write(`  ${status}\n`);
    process.stdout.write('\n');
    process.stdout.write(`  ${dim('↑/↓ move · Enter select · q quit')}\n`);
    process.stdout.write('\n');
    items.forEach((item, i) => {
      const selected = i === index;
      const prefix = selected ? pink('▸ ') : '  ';
      const label = selected ? pink(bold(item.label)) : dim(item.label);
      process.stdout.write(`  ${prefix}${label}\n`);
    });
    process.stdout.write('\n');
    process.stdout.write(`  ${dim('made by')} ${green('cognitek.dev')}\n`);
    process.stdout.write('\n');
  }

  return new Promise((resolve) => {
    function cleanup(): void {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      // No stdin.pause() — the selected handler (init wizard) needs the
      // stream still flowing for its own readline prompts.
      showCursor();
      // Leave the alt-screen buffer so the terminal restores to its
      // pre-menu state (same pattern as vim/less). Without this the
      // menu lingers on screen and the shell prompt prints below it,
      // which feels like being "stuck in the menu".
      exitAltScreen();
    }

    function onData(chunk: Buffer): void {
      const s = chunk.toString();
      // Ctrl-C
      if (s === '\x03') {
        cleanup();
        resolve(-1);
        return;
      }
      // q
      if (s === 'q' || s === 'Q') {
        cleanup();
        resolve(-1);
        return;
      }
      // Enter / Return
      if (s === '\r' || s === '\n') {
        cleanup();
        resolve(index);
        return;
      }
      // Arrow up: \x1b[A ; arrow down: \x1b[B
      if (s === '\x1b[A' || s === 'k') {
        index = (index - 1 + items.length) % items.length;
        redraw();
        return;
      }
      if (s === '\x1b[B' || s === 'j') {
        index = (index + 1) % items.length;
        redraw();
        return;
      }
      // Number shortcuts: 1..9 pick directly.
      if (/^[1-9]$/.test(s)) {
        const n = Number(s) - 1;
        if (n < items.length) {
          cleanup();
          resolve(n);
          return;
        }
      }
      // Unknown key — ignore.
    }

    if (!stdin.setRawMode) {
      // Non-TTY: just auto-pick the first item and hand off. This matches
      // scripts piping input (which should use subcommands anyway).
      resolve(0);
      return;
    }
    // Safety net: if the process dies without going through onData (e.g.
    // SIGTERM from outside), still drop the alt-screen + restore cursor
    // so the operator's terminal isn't left in a weird state.
    const onExit = (): void => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h\x1b[?1049l');
      }
    };
    process.once('exit', onExit);
    enterAltScreen();
    hideCursor();
    stdin.setRawMode(true);
    (stdin as unknown as { resume?: () => void }).resume?.();
    stdin.on('data', onData);
    redraw();
  });
}

/**
 * Read the core service's semver from package.json. Uses module-relative
 * resolution — works both in dev (tsx) and dist (built) contexts.
 */
function readCoreVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // menu.js lives in dist/cli/ (or src/cli/ in dev); package.json is two up.
    const pkgPath = resolve(here, '..', '..', 'package.json');
    if (!existsSync(pkgPath)) {
      // Dev via tsx: here is src/cli, same depth → works.
      return (
        (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string })
          .version ?? '0.0.0'
      );
    }
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string;
    };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Heuristic: "setup done" = .env has a non-empty TELEGRAM_BOT_TOKEN AND
 * config.yaml mentions a non-empty allowedUserIds list. Good enough for
 * the menu to change labels; real validation is `andybioticlaw config
 * validate` + an actual service boot.
 */
function detectSetupDone(): boolean {
  try {
    const envPath = defaultEnvPath(projectRoot());
    const configPath = defaultConfigPath(projectRoot());
    if (!existsSync(envPath) || !existsSync(configPath)) return false;
    const envBody = readFileSync(envPath, 'utf8');
    const hasToken = /^TELEGRAM_BOT_TOKEN=.+\S/m.test(envBody);
    const configBody = readFileSync(configPath, 'utf8');
    const hasAllow = /^\s+allowedUserIds:\s*\[\s*\d+/m.test(configBody);
    return hasToken && hasAllow;
  } catch {
    return false;
  }
}
