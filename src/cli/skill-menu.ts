import pino from 'pino';
import { bootstrapEnv, loadConfig, projectRoot } from '../config/load.js';
import {
  expandPath,
  defaultEnvPath,
  sqliteDbPath,
} from '../config/paths.js';
import { openDatabase } from '../db/index.js';
import { createAuditRepo } from '../db/repositories/audit.js';
import { createSkillRegistry } from '../skills/registry.js';
import type { SkillRecord } from '../skills/registry.js';
import { loadSkills } from '../skills/loader.js';
import { arrowPicker, releaseStdin } from './prompt-helpers.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';
import { runSkillSetup, SkillSetupError } from './skill-setup.js';

/**
 * Top-level menu handler for "Add / configure skills". Lists every skill
 * found under `skills/`, lets the operator pick one with arrow keys, then
 * runs the shared setup flow. Loops until the operator picks "Back".
 *
 * Only shows skills that have a `setupWizard` block — skills without a
 * wizard have nothing to ask about; those get rendered but disabled in
 * the picker (user can still pick them to see their status).
 */
export async function runSkillMenuCommand(): Promise<void> {
  bootstrapEnv();
  const loaded = loadConfig();
  const config = loaded.config;
  const dataDir = expandPath(config.service.dataDir, projectRoot());
  const logger = pino({ level: 'warn' });
  const dbHandle = openDatabase(sqliteDbPath(dataDir), logger);
  const stdin = process.stdin as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void;
  };
  const stdout = process.stdout;

  try {
    const registry = createSkillRegistry(dbHandle.db);
    const audit = createAuditRepo(dbHandle.db);
    loadSkills({
      dir: expandPath(config.skills.dir, projectRoot()),
      logger,
      registry,
    });

    const envPath = defaultEnvPath(projectRoot());

    stdout.write(
      `\n${bold(lavender('andybioticlaw'))} ${dim('— add / configure skills')}\n` +
        dim(`  skills live at ${expandPath(config.skills.dir, projectRoot())}\n`) +
        dim(`  pick a skill to (re)run its setup wizard\n\n`),
    );

    while (true) {
      // Rebuild every iteration — after a setup run, secret-presence changes.
      const skills = registry.list();
      if (skills.length === 0) {
        stdout.write(
          `  ${yellow('!')} ${dim('no skills found under `skills/`.')}\n\n`,
        );
        return;
      }

      const items = skills.map((s) => ({
        label: s.name,
        meta: ` ${describeStatus(s)}`,
      }));
      items.push({ label: 'Back', meta: '' });

      const idx = await arrowPicker(stdin, stdout, {
        title: 'Skills',
        helpLine: '↑/↓ move · Enter select · q back',
        items,
      });
      if (idx < 0 || idx === items.length - 1) return;

      const chosen = skills[idx];
      if (!chosen) return;
      if (!chosen.setupWizard) {
        stdout.write(
          `\n  ${yellow('!')} ${dim(
            `skill "${chosen.name}" has no setup_wizard block. ` +
              `Nothing to configure from here — edit manifest.yaml or install by hand.`,
          )}\n\n`,
        );
        continue;
      }

      stdout.write(`\n${dim('──')} ${cyan(chosen.name)} ${dim('──')}\n\n`);
      try {
        await runSkillSetup({
          skill: chosen,
          registry,
          audit,
          logger,
          envPath,
          dataDir,
          runInstall: true,
          sighup: true,
        });
      } catch (e) {
        if (e instanceof SkillSetupError) {
          stdout.write(`\n  ${yellow('!')} ${dim(e.message)}\n`);
          // Don't bail the whole menu — let the operator retry or pick another.
        } else {
          throw e;
        }
      }

      stdout.write('\n');
    }
  } finally {
    dbHandle.close();
    releaseStdin();
  }
}

/**
 * Human-readable status line for the skill picker. Shows enabled state +
 * secret presence so the operator can tell at a glance whether a skill is
 * ready or still needs configuration.
 */
function describeStatus(skill: SkillRecord): string {
  const missing = skill.requiredSecrets.filter((n) => {
    const v = process.env[n];
    return typeof v !== 'string' || v.trim() === '';
  });
  const parts: string[] = [];
  if (skill.enabled) parts.push(sage('enabled'));
  else parts.push(dim('disabled'));
  if (missing.length > 0) {
    parts.push(yellow(`${missing.length} secret${missing.length > 1 ? 's' : ''} missing`));
  } else if (skill.requiredSecrets.length > 0) {
    parts.push(green('configured'));
  }
  if (!skill.setupWizard) parts.push(dim('no wizard'));
  return parts.join(dim(' · '));
}
