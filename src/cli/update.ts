import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../config/load.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';

/**
 * `andybioticlaw update` — pulls the latest source, reinstalls deps,
 * rebuilds backend + frontend, prunes dev dependencies. Does NOT restart
 * systemd (that needs root and is the operator's call).
 *
 * Must run inside the install-dir checkout, as the user who owns it
 * (typically the `andybioticlaw` service user — reach it via
 * `sudo -iu andybioticlaw andybioticlaw update`).
 *
 * Safety rails:
 *   - aborts if `git status` shows uncommitted local changes
 *   - aborts if `.git` isn't present (i.e. the install wasn't done from
 *     a clone; the operator needs to re-run install.sh manually)
 *   - warns if the systemd unit template drifted vs. the installed unit
 *     — that case also needs `sudo bash scripts/install.sh`, beyond
 *     a restart.
 */
export async function runUpdateCommand(): Promise<void> {
  const root = projectRoot();

  header('andybioticlaw update');
  process.stdout.write(`  ${dim(`in ${root}`)}\n\n`);

  // Pre-flight: we need a git checkout to pull from.
  if (!existsSync(resolve(root, '.git'))) {
    process.stderr.write(
      `  ${yellow('⚠')} ${dim('no .git directory — this install was not deployed from a clone.')}\n` +
        `  ${dim('Re-run scripts/install.sh from a fresh clone to pick up updates.')}\n\n`,
    );
    process.exit(1);
  }

  // Pre-flight: refuse to pull over local modifications.
  const status = captureSync('git', ['status', '--porcelain'], root);
  if (status.trim()) {
    process.stderr.write(
      `  ${yellow('⚠')} ${dim('working tree has local changes:')}\n` +
        status
          .split('\n')
          .map((l) => `    ${dim(l)}`)
          .join('\n') +
        `\n  ${dim(`commit / stash / revert first, then retry.`)}\n\n`,
    );
    process.exit(1);
  }

  // Capture the pre-pull HEAD so we can say "no changes" or list commits.
  const headBefore = captureSync('git', ['rev-parse', 'HEAD'], root).trim();

  step('git pull --ff-only');
  runSync('git', ['pull', '--ff-only'], root);

  const headAfter = captureSync('git', ['rev-parse', 'HEAD'], root).trim();
  const pulledCommits = headBefore !== headAfter;
  if (!pulledCommits) {
    process.stdout.write(`    ${dim('already up to date — nothing else to do.')}\n\n`);
    process.stdout.write(`  ${sage('✓')} ${green('up to date.')}\n\n`);
    return;
  }

  // Short log of what came down so the operator sees what changed.
  const log = captureSync(
    'git',
    ['log', '--oneline', '--no-decorate', `${headBefore}..${headAfter}`],
    root,
  );
  if (log.trim()) {
    process.stdout.write(`    ${dim('new commits:')}\n`);
    for (const line of log.trim().split('\n').slice(0, 10)) {
      process.stdout.write(`    ${dim('·')} ${line}\n`);
    }
    process.stdout.write('\n');
  }

  step('pnpm install --frozen-lockfile');
  runSync('pnpm', ['install', '--frozen-lockfile'], root);

  step('pnpm build');
  runSync('pnpm', ['build'], root);

  // Web frontend is a pnpm workspace member — only build if present.
  const webDir = resolve(root, 'web');
  if (existsSync(resolve(webDir, 'package.json'))) {
    step('pnpm --filter @andybioticlaw/web build');
    runSync('pnpm', ['--filter', '@andybioticlaw/web', 'build'], root);
  }

  step('pnpm install --prod --frozen-lockfile   (drop dev deps)');
  runSync('pnpm', ['install', '--prod', '--frozen-lockfile'], root);

  // Warn if systemd unit template drifted. Compare .template against the
  // rendered unit (with __INSTALL_DIR__ back-substituted).
  const driftWarning = detectSystemdDrift(root);
  if (driftWarning) {
    process.stdout.write(
      `\n  ${yellow('⚠')} ${dim(driftWarning)}\n` +
        `    ${dim('Re-run:')}  ${cyan(`sudo bash ${root}/scripts/install.sh`)}\n`,
    );
  }

  process.stdout.write(`\n  ${sage('✓')} ${green('update complete.')}\n\n`);
  process.stdout.write(
    `  ${dim('To apply:')}  ${cyan('sudo systemctl restart andybioticlaw')}\n` +
      `  ${dim('Then watch:')} ${cyan('sudo journalctl -u andybioticlaw -f')}\n\n`,
  );
}

function header(title: string): void {
  process.stdout.write(`\n${bold(lavender(title))}\n`);
}

function step(line: string): void {
  process.stdout.write(`  ${lavender('▸')} ${bold(line)}\n`);
}

function runSync(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    // pnpm in non-TTY contexts (sudo -iu wrapped commands) refuses to
    // auto-purge an out-of-date node_modules with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. Setting CI=true is
    // pnpm's own documented escape hatch — it then assumes "yes" to
    // the purge prompt. We forward the rest of process.env so existing
    // PATH / HOME / NODE_ENV are preserved.
    env: { ...process.env, CI: 'true' },
  });
  if (r.error) {
    throw new Error(`failed to spawn ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${r.status}`);
  }
}

function captureSync(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.error) {
    throw new Error(`failed to spawn ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr?.toString?.() ?? ''}`,
    );
  }
  return r.stdout ?? '';
}

/**
 * Best-effort comparison: did `systemd/*.template` change in a way that
 * the installed `/etc/systemd/system/andybioticlaw.service` no longer
 * reflects? We can't sudo read that file from an unprivileged process,
 * so we check whether the installed unit even exists and hint at a
 * possible re-install when it does but the template is newer.
 *
 * Returns a warning string, or null if everything looks fine.
 */
function detectSystemdDrift(root: string): string | null {
  const tpl = resolve(root, 'systemd', 'andybioticlaw.service.template');
  if (!existsSync(tpl)) return null;
  try {
    const tplBody = readFileSync(tpl, 'utf8');
    // If template has a new placeholder we haven't seen before, flag it.
    const knownPlaceholders = ['__INSTALL_DIR__', '__SERVICE_HOME__'];
    const used = tplBody.match(/__[A-Z_]+__/g) ?? [];
    const novel = used.filter((p) => !knownPlaceholders.includes(p));
    if (novel.length > 0) {
      return `systemd template references new placeholder(s) ${novel.join(', ')} — the installer likely changed.`;
    }
  } catch {
    // non-fatal
  }
  return null;
}
