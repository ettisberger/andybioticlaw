import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, projectRoot } from '../../config/load.js';
import { expandPath, pidFilePath } from '../../config/paths.js';
import { cyan, dim, green, sage, yellow } from '../ansi.js';
import type { SettingsContext } from './types.js';

/**
 * Surgical YAML patch + post-write announce. Preserves comments +
 * unrelated whitespace because it's a line-oriented regex replace,
 * not a full YAML parse + dump.
 *
 * Restart-handling split from edit-config.ts's predecessor: `patchYaml`
 * returns a structured result; the per-field "restart required" hint
 * that the predecessor printed inline has MOVED to the settings-menu
 * footer banner (one persistent badge rather than many scattered
 * lines). Per-field "✓ updated" + SIGHUP-sent are still printed so the
 * operator gets immediate feedback that their change landed.
 */
export interface PatchResult {
  /** True iff the regex matched and the file bytes changed. */
  patched: boolean;
  /** True iff the post-write Zod validation was happy. */
  validationOk: boolean;
}

export function patchYaml(
  ctx: SettingsContext,
  regex: RegExp,
  replacement: string,
  pathLabel: string,
  before: string,
  after: string,
  restart: boolean,
): PatchResult {
  const body = ctx.readYaml();
  const next = body.replace(regex, replacement);
  if (next === body) {
    ctx.stdout.write(
      `  ${yellow('!')} ${dim(`could not patch ${pathLabel} — line not found in config.yaml. Edit manually.`)}\n\n`,
    );
    return { patched: false, validationOk: false };
  }
  ctx.writeYaml(next);

  let validationOk = true;
  try {
    loadConfig();
  } catch (e) {
    validationOk = false;
    ctx.stdout.write(
      `  ${yellow('⚠')} ${dim(`config validation failed after patch: ${(e as Error).message}`)}\n`,
    );
  }

  ctx.stdout.write(
    `  ${sage('✓')} ${green('updated')} ${cyan(pathLabel)}: ${dim(before)} ${dim('→')} ${cyan(after)}\n`,
  );

  if (!validationOk) {
    ctx.stdout.write(
      `  ${yellow('!')} ${dim(`re-edit or rollback config.yaml manually before restarting.`)}\n\n`,
    );
    return { patched: true, validationOk: false };
  }

  // Live-reloadable fields SIGHUP the daemon right here so the change
  // takes effect immediately. Restart-required fields rely on the
  // settings-menu footer banner to tell the operator to restart.
  if (!restart) {
    sendSighupIfRunning(ctx.stdout);
  }
  ctx.stdout.write('\n');
  return { patched: true, validationOk: true };
}

function sendSighupIfRunning(stdout: NodeJS.WritableStream): void {
  let dataDir: string;
  try {
    const loaded = loadConfig();
    dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
  } catch {
    return;
  }
  const pidPath = pidFilePath(dataDir);
  if (!existsSync(pidPath)) {
    stdout.write(
      `  ${dim('(no running daemon detected — change will take effect on next start)')}\n`,
    );
    return;
  }
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) return;
  try {
    process.kill(pid, 'SIGHUP');
    stdout.write(
      `  ${sage('✓')} ${green('live-reloaded')} ${dim(`(SIGHUP sent to daemon pid ${pid})`)}\n`,
    );
  } catch {
    stdout.write(
      `  ${dim('(daemon pidfile present but process not reachable — restart to apply)')}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Line-oriented readers. Used by components to surface the current value
// on every render frame. Pure; no side effects.
// ---------------------------------------------------------------------------

export function matchString(body: string, re: RegExp, dflt: string): string {
  const m = body.match(re);
  return m && m[1] !== undefined ? m[1] : dflt;
}

export function matchInt(body: string, re: RegExp, dflt: number): number {
  const m = body.match(re);
  if (!m || m[1] === undefined) return dflt;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : dflt;
}

export function matchBool(body: string, re: RegExp, dflt: boolean): boolean {
  const m = body.match(re);
  if (!m || m[1] === undefined) return dflt;
  return m[1] === 'true';
}

export function matchIntOrNull(body: string, re: RegExp): number | null {
  const m = body.match(re);
  if (!m || m[1] === undefined) return null;
  if (m[1] === 'null') return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

export function matchIntList(body: string, re: RegExp): number[] {
  const m = body.match(re);
  if (!m || m[1] === undefined) return [];
  const inside = m[1].trim();
  if (!inside) return [];
  return inside
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function passwordHashIsSet(body: string): boolean {
  return /^\s+passwordHash:\s*['"][^'"]+['"]\s*$/m.test(body);
}
