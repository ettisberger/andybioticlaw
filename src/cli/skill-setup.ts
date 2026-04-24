import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { AuditRepo } from '../db/repositories/audit.js';
import { pidFilePath } from '../config/paths.js';
import { installSkill } from '../skills/installer.js';
import type { SkillRecord, SkillRegistry } from '../skills/registry.js';
import { runSetupWizard, WizardAbortedError } from './wizard.js';

export interface RunSkillSetupInput {
  /** Target skill. Must have a non-null `setupWizard`. */
  skill: SkillRecord;
  registry: SkillRegistry;
  audit: AuditRepo;
  logger: Logger;
  /** Path to `.env` where wizard-collected secrets get written. */
  envPath: string;
  /** Data dir holding the pidfile for SIGHUP. */
  dataDir: string;
  /** Run `install.sh` after the wizard. Default: true. */
  runInstall?: boolean;
  /** SIGHUP the running daemon after install so it re-scans skills. Default: true. */
  sighup?: boolean;
  /** Output sink; defaults to `process.stdout`. Lets the menu intercept/format. */
  stdout?: NodeJS.WritableStream;
  /** Error sink; defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
}

export class SkillSetupError extends Error {
  constructor(
    message: string,
    readonly stage: 'wizard-aborted' | 'no-wizard' | 'install-failed',
  ) {
    super(message);
    this.name = 'SkillSetupError';
  }
}

/**
 * Shared "run the skill wizard + install.sh + SIGHUP" flow. Used by both
 * the `andybioticlaw skill setup <name>` CLI command and the TUI menu's
 * "Add / configure skills" handler. Keeps one source of truth for what
 * a skill setup actually does.
 *
 * Throws `SkillSetupError` with a `.stage` for the three failure modes:
 *   - 'wizard-aborted'  (Ctrl-C / q during prompts)
 *   - 'no-wizard'       (skill has no setupWizard block)
 *   - 'install-failed'  (install.sh exited non-zero)
 * Other thrown errors bubble up unchanged.
 */
export async function runSkillSetup(input: RunSkillSetupInput): Promise<void> {
  const {
    skill,
    registry,
    audit,
    logger,
    envPath,
    dataDir,
    runInstall = true,
    sighup = true,
    stdout = process.stdout,
    stderr = process.stderr,
  } = input;

  if (!skill.setupWizard) {
    throw new SkillSetupError(
      `skill ${skill.name} has no setup_wizard block in its manifest.yaml`,
      'no-wizard',
    );
  }

  // Disable bracketed-paste mode for the ENTIRE setup flow (wizard +
  // install.sh + SIGHUP). Modern terminals bracket pastes with
  // `\x1b[200~…\x1b[201~`, and bash's `read` (used by install scripts)
  // does NOT strip them — so without this a pasted OAuth code lands
  // in the shell var as e.g. `\x1b[200~abc123\x1b[201~` and the token
  // exchange fails. Re-enabled in the finally so the operator's shell
  // is left how we found it; if we crash mid-flow, shells re-enable
  // bracketed paste on their next prompt anyway.
  stdout.write('\x1b[?2004l');
  try {
    try {
      await runSetupWizard({
        skillName: skill.name,
        wizard: skill.setupWizard,
        envPath,
      });
    } catch (e) {
      if (e instanceof WizardAbortedError) {
        throw new SkillSetupError('wizard aborted by operator', 'wizard-aborted');
      }
      throw e;
    }

    if (runInstall) {
      stdout.write('\nRunning install.sh…\n');
      try {
        // `stream: true` forwards the child's stdout/stderr live to the
        // terminal. Critical for install scripts that print something
        // the operator must act on (e.g. the OAuth device-code URL +
        // user-code box in google-calendar's install.sh). Without it
        // the output is buffered until exit, which looks like the
        // command hung and makes the device flow impossible to
        // complete.
        const out = await installSkill(
          skill.name,
          { registry, audit, logger },
          { autoConfirm: true, stream: true },
        );
        if (!out.ran) {
          stdout.write('(no install.sh — skill recorded as installed.)\n');
        }
        // In stream mode the script body already appeared on the
        // terminal as it ran; re-printing `out.stdout` would
        // double-print. So we don't. An explicit "✓" line here so the
        // operator knows the script ended cleanly (vs. still-running /
        // hung):
        if (out.ran) {
          stdout.write('\n✓ install.sh exited cleanly.\n');
        }
      } catch (e) {
        throw new SkillSetupError(
          `install.sh FAILED: ${(e as Error).message}`,
          'install-failed',
        );
      }
    }

    if (sighup) {
      const pidPath = pidFilePath(dataDir);
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        try {
          process.kill(pid, 'SIGHUP');
          stdout.write(
            `\n✓ SIGHUP sent to pid ${pid} — skill registry will re-scan.\n`,
          );
        } catch (e) {
          stderr.write(
            `could not SIGHUP daemon (pid ${pid}): ${(e as Error).message}\n`,
          );
        }
      } else {
        stdout.write(
          '\n(daemon not running — skill will be picked up on next start.)\n',
        );
      }
    }

    stdout.write(`\nSkill "${skill.name}" is ready.\n`);
  } finally {
    // Restore bracketed paste for the operator's shell.
    stdout.write('\x1b[?2004h');
  }
}
