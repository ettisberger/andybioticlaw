import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { SkillRegistry } from './registry.js';
import type { SkillRecord } from './registry.js';
import { dim } from '../cli/ansi.js';
import { section } from '../cli/section.js';

const pexec = promisify(execFile);

/** Number of leading lines from install.sh we print as a preview. */
const PREVIEW_LINES = 30;

export interface SkillInstallDeps {
  registry: SkillRegistry;
  audit: AuditRepo;
  logger: Logger;
}

export interface SkillInstallOptions {
  /**
   * If true, the install proceeds without waiting for an interactive
   * y/N confirmation. The script preview is still printed. Use in
   * non-interactive contexts (CI, bootstrap scripts) where an operator
   * has already reviewed the skill source out-of-band.
   */
  autoConfirm?: boolean;
  /**
   * Called after the preview is printed, before install.sh runs. Must
   * return true to proceed. Default: reads y/N from stdin via readline.
   * Overridable for tests.
   */
  confirm?: (skillName: string) => Promise<boolean>;
  /**
   * Stream install.sh's stdout/stderr live to the parent process in real
   * time (for interactive flows — e.g. an OAuth device-code handshake
   * where the operator has to SEE the URL and user code before approving
   * on their phone). Default: false (buffered via pexec).
   */
  stream?: boolean;
  /**
   * Override install.sh's timeout in ms. Defaults:
   *   - buffered mode: 120_000 (2 min — anything slower is probably stuck)
   *   - stream mode:   1_800_000 (30 min — matches Google's device-code TTL;
   *                                no point waiting longer)
   */
  timeoutMs?: number;
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
 *
 * Prints a preview of the first {@link PREVIEW_LINES} lines and asks for
 * y/N confirmation before running, because the script executes as the
 * service user with full filesystem access. Use `autoConfirm: true` to
 * skip the prompt in non-interactive flows (preview is still printed so
 * the decision is at least logged).
 */
export async function installSkill(
  name: string,
  deps: SkillInstallDeps,
  opts: SkillInstallOptions = {},
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

  // Preview the script so the operator can eyeball it before it runs as
  // the service user with full shell access.
  try {
    const body = readFileSync(script, 'utf8');
    const lines = body.split('\n');
    const head = lines.slice(0, PREVIEW_LINES);
    section(
      process.stdout,
      'preview',
      `${name}/install.sh (first ${head.length} of ${lines.length} lines)`,
    );
    for (const line of head) process.stdout.write(`  ${dim('│')} ${line}\n`);
    if (lines.length > head.length) {
      process.stdout.write(
        `  ${dim('│')} ${dim(`… (${lines.length - head.length} more lines)`)}\n`,
      );
    }
    process.stdout.write('\n');
  } catch (e) {
    // Unreadable script → fail BEFORE confirm so we don't run garbage.
    throw new Error(`could not read ${script}: ${(e as Error).message}`);
  }

  if (!opts.autoConfirm) {
    const ok = await (opts.confirm ?? defaultConfirm)(name);
    if (!ok) {
      deps.audit.record({
        kind: 'skill_install_rejected',
        actor: 'cli',
        detail: { name, version: skill.version, reason: 'preview not confirmed' },
      });
      throw new Error(`skill ${name} install aborted by operator`);
    }
  }

  deps.logger.info(
    { name, script, stream: opts.stream === true },
    'running skill install.sh',
  );
  const stream = opts.stream === true;
  const timeoutMs =
    opts.timeoutMs ?? (stream ? 1_800_000 : 120_000);
  try {
    const runResult = stream
      ? await runStreamed(script, skill, timeoutMs)
      : await runBuffered(script, skill, timeoutMs);
    const combined = [runResult.stdout, runResult.stderr]
      .filter(Boolean)
      .join('\n---stderr---\n');
    deps.registry.recordInstall(name, combined);
    deps.audit.record({
      kind: 'skill_install',
      actor: 'cli',
      detail: { name, exitCode: 0, version: skill.version, stream },
    });
    return {
      name,
      ran: true,
      exitCode: 0,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
    };
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
      detail: {
        name,
        exitCode,
        error: stderr.slice(0, 400),
        version: skill.version,
        stream,
      },
    });
    throw new Error(`skill ${name} install failed (exit ${exitCode}): ${stderr.slice(0, 400)}`);
  }
}

/**
 * Buffered exec — captures all stdout/stderr in memory via execFile. Used
 * for non-interactive installs where we want the full output recorded
 * atomically (e.g. a future dashboard-triggered install button).
 */
async function runBuffered(
  script: string,
  skill: SkillRecord,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await pexec('/usr/bin/env', ['bash', script], {
    cwd: skill.skillDir,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * Streamed exec — forwards stdout/stderr to the parent process in real
 * time so interactive install scripts (OAuth device flow printing a URL
 * that the operator must act on) are actually visible as they run.
 * Simultaneously tees into buffers so `recordInstall` still has the full
 * output for `skill_state.last_install_output`.
 *
 * On non-zero exit / timeout, throws with the same shape as the buffered
 * path (an Error decorated with `.stdout`, `.stderr`, `.code`) so the
 * outer error-handling works unchanged.
 */
async function runStreamed(
  script: string,
  skill: SkillRecord,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/env', ['bash', script], {
      cwd: skill.skillDir,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stdoutBuf += s;
      process.stdout.write(s);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderrBuf += s;
      process.stderr.write(s);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      const e = new Error(
        `failed to spawn bash for ${skill.name}/install.sh: ${err.message}`,
      ) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      e.stdout = stdoutBuf;
      e.stderr = stderrBuf || err.message;
      e.code = 1;
      rejectPromise(e);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout: stdoutBuf, stderr: stderrBuf });
        return;
      }
      const suffix = signal ? ` (signal ${signal})` : '';
      const e = new Error(
        `install.sh exited ${code ?? 'null'}${suffix}`,
      ) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      e.stdout = stdoutBuf;
      e.stderr = stderrBuf || e.message;
      e.code = typeof code === 'number' ? code : 1;
      rejectPromise(e);
    });
  });
}

/**
 * Interactive y/N prompt on process.stdin / stdout. Default fallback for
 * `SkillInstallOptions.confirm`. Returns true only for a plain "y" or
 * "yes" (case-insensitive). Anything else — including EOF / non-TTY
 * stdin — returns false, i.e. "abort, better safe".
 */
async function defaultConfirm(skillName: string): Promise<boolean> {
  process.stdout.write(
    `Proceed with running ${skillName}/install.sh as the service user? [y/N] `,
  );
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const ans = chunk.toString().trim().toLowerCase();
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(ans === 'y' || ans === 'yes');
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
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
