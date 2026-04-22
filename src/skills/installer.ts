import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { SkillRegistry } from './registry.js';

const pexec = promisify(execFile);

export interface SkillInstallDeps {
  registry: SkillRegistry;
  audit: AuditRepo;
  logger: Logger;
}

export interface InstallResult {
  name: string;
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the skill's `install.sh` if present. `install.sh` MUST be idempotent —
 * the skill contract requires it. Output is recorded in `skill_state.last_install_output`
 * for later inspection via CLI / dashboard.
 */
export async function installSkill(
  name: string,
  deps: SkillInstallDeps,
): Promise<InstallResult> {
  const skill = deps.registry.get(name);
  if (!skill) throw new Error(`skill not registered: ${name}`);

  const script = resolve(skill.skillDir, 'install.sh');
  if (!existsSync(script)) {
    deps.registry.recordInstall(name, null);
    deps.audit.record({
      kind: 'skill_install',
      actor: 'cli',
      detail: { name, scriptPresent: false, version: skill.version },
    });
    deps.logger.info({ name }, 'skill install: no install.sh, recorded as installed');
    return { name, ran: false, exitCode: 0, stdout: '', stderr: '' };
  }

  deps.logger.info({ name, script }, 'running skill install.sh');
  try {
    const { stdout, stderr } = await pexec('/usr/bin/env', ['bash', script], {
      cwd: skill.skillDir,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
    deps.registry.recordInstall(name, combined);
    deps.audit.record({
      kind: 'skill_install',
      actor: 'cli',
      detail: { name, exitCode: 0, version: skill.version },
    });
    return { name, ran: true, exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = err.stdout ?? '';
    const stderr = err.stderr ?? err.message;
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    const combined = [stdout, stderr].filter(Boolean).join('\n---stderr---\n');
    deps.registry.recordInstall(name, combined);
    deps.audit.record({
      kind: 'skill_install',
      actor: 'cli',
      detail: { name, exitCode, error: stderr.slice(0, 400), version: skill.version },
    });
    throw new Error(`skill ${name} install failed (exit ${exitCode}): ${stderr.slice(0, 400)}`);
  }
}

/** Run the uninstall.sh if present. The registry entry is NOT removed — the
 * skill remains on disk; disable it with `skill disable` if you also want it
 * deactivated. */
export async function uninstallSkill(
  name: string,
  deps: SkillInstallDeps,
): Promise<InstallResult> {
  const skill = deps.registry.get(name);
  if (!skill) throw new Error(`skill not registered: ${name}`);
  const script = resolve(skill.skillDir, 'uninstall.sh');
  if (!existsSync(script)) {
    deps.audit.record({
      kind: 'skill_uninstall',
      actor: 'cli',
      detail: { name, scriptPresent: false, version: skill.version },
    });
    return { name, ran: false, exitCode: 0, stdout: '', stderr: '' };
  }
  const { stdout, stderr } = await pexec('/usr/bin/env', ['bash', script], {
    cwd: skill.skillDir,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  deps.audit.record({
    kind: 'skill_uninstall',
    actor: 'cli',
    detail: { name, exitCode: 0, version: skill.version },
  });
  return { name, ran: true, exitCode: 0, stdout, stderr };
}
