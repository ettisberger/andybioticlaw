import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { projectRoot } from '../config/load.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';

/**
 * `andybioticlaw update` — updates the install in place. Dual-mode:
 *
 *   Git install (`.git/` present):
 *     git pull + pnpm install + build + prune dev deps.
 *     Picks up tip-of-main. Meant for contributors / tracking development.
 *
 *   Release install (`.git/` absent):
 *     Query GitHub `/releases/latest`, download the tarball asset,
 *     extract into a staging dir, rsync over the install dir preserving
 *     `data/`, `config/config.yaml`, `.env`, then run
 *     `pnpm install --prod --frozen-lockfile` to compile native modules
 *     for this host. Meant for end users tracking stable releases.
 *
 * Never restarts systemd — that needs root and is the operator's call.
 * Never touches `data/` / `config/config.yaml` / `.env`.
 *
 * Runs as the install-dir owner. For a production install, reach it via
 * `sudo -iu andybioticlaw andybioticlaw update`.
 */
export async function runUpdateCommand(): Promise<void> {
  const root = projectRoot();

  header('andybioticlaw update');
  process.stdout.write(`  ${dim(`in ${root}`)}\n\n`);

  if (existsSync(resolve(root, '.git'))) {
    await runGitUpdate(root);
  } else {
    await runReleaseUpdate(root);
  }
}

// ---------------------------------------------------------------------------
// Git-mode (contributor workflow)
// ---------------------------------------------------------------------------

async function runGitUpdate(root: string): Promise<void> {
  process.stdout.write(`  ${dim('mode: git clone — pulling main.')}\n\n`);

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

  const headBefore = captureSync('git', ['rev-parse', 'HEAD'], root).trim();

  step('git pull --ff-only');
  runSync('git', ['pull', '--ff-only'], root);

  const headAfter = captureSync('git', ['rev-parse', 'HEAD'], root).trim();
  if (headBefore === headAfter) {
    process.stdout.write(`    ${dim('already up to date — nothing else to do.')}\n\n`);
    process.stdout.write(`  ${sage('✓')} ${green('up to date.')}\n\n`);
    return;
  }

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

  const webDir = resolve(root, 'web');
  if (existsSync(resolve(webDir, 'package.json'))) {
    step('pnpm --filter @andybioticlaw/web build');
    runSync('pnpm', ['--filter', '@andybioticlaw/web', 'build'], root);
  }

  step('pnpm install --prod --frozen-lockfile   (drop dev deps)');
  runSync('pnpm', ['install', '--prod', '--frozen-lockfile'], root);

  const driftWarning = detectSystemdDrift(root);
  if (driftWarning) {
    process.stdout.write(
      `\n  ${yellow('⚠')} ${dim(driftWarning)}\n` +
        `    ${dim('Re-run:')}  ${cyan(`sudo bash ${root}/scripts/install.sh`)}\n`,
    );
  }

  finishSuccessHint();
}

// ---------------------------------------------------------------------------
// Release-mode (end-user workflow)
// ---------------------------------------------------------------------------

async function runReleaseUpdate(root: string): Promise<void> {
  const pkg = readPackageJson(root);
  const repo = parseGithubRepo(pkg);

  process.stdout.write(
    `  ${dim(`mode: release tarball — checking github.com/${repo}/releases.`)}\n\n`,
  );
  process.stdout.write(`  ${dim(`current version:`)} ${cyan(`v${pkg.version ?? 'unknown'}`)}\n`);

  step('fetch latest release info');
  const latest = await fetchLatestRelease(repo);
  process.stdout.write(
    `    ${dim('tag:')}         ${cyan(latest.tag)}\n` +
      `    ${dim('published:')}  ${dim(latest.publishedAt)}\n` +
      `    ${dim('asset:')}      ${dim(latest.assetName)}  (${formatBytes(latest.assetSize)})\n\n`,
  );

  // Compare — skip download if the install is already at the latest tag.
  const currentTag = pkg.version ? `v${pkg.version}` : '';
  if (currentTag && currentTag === latest.tag) {
    process.stdout.write(`  ${sage('✓')} ${green('already at the latest release.')}\n\n`);
    return;
  }

  // Prepare a fresh staging dir under /tmp. Auto-cleaned on success.
  const staging = resolve(tmpdir(), `andybioticlaw-update-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const tarPath = resolve(staging, 'release.tar.gz');
    step(`download ${latest.assetName}`);
    await downloadFile(latest.assetUrl, tarPath);

    step('extract');
    runSync('tar', ['xzf', tarPath, '-C', staging]);
    const extracted = findExtractedRoot(staging);
    if (!extracted) {
      throw new Error(`extracted tarball has no top-level directory under ${staging}`);
    }

    // Sanity check: the tarball must contain dist/ + package.json, otherwise
    // the rsync will leave us with a half-copied install that won't boot.
    for (const required of ['package.json', 'dist/index.js']) {
      if (!existsSync(resolve(extracted, required))) {
        throw new Error(`release tarball is missing ${required} — refusing to overwrite install`);
      }
    }

    step('rsync over install dir (preserving data/, config.yaml, .env)');
    runSync('rsync', [
      '-a',
      '--delete',
      // Preserved across updates — we NEVER overwrite these.
      '--exclude=data/',
      '--exclude=config/config.yaml',
      '--exclude=config/config.local.yaml',
      '--exclude=.env',
      '--exclude=.env.local',
      '--exclude=.env.*.local',
      // `pnpm install --prod` rebuilds this for the host arch below.
      '--exclude=node_modules/',
      `${extracted}/`,
      `${root}/`,
    ]);

    step('pnpm install --prod --frozen-lockfile');
    runSync('pnpm', ['install', '--prod', '--frozen-lockfile'], root);

    const driftWarning = detectSystemdDrift(root);
    if (driftWarning) {
      process.stdout.write(
        `\n  ${yellow('⚠')} ${dim(driftWarning)}\n` +
          `    ${dim('Re-run:')}  ${cyan(`sudo bash ${root}/scripts/install.sh`)}\n`,
      );
    }

    process.stdout.write(
      `\n  ${sage('✓')} ${green('updated')} ${dim(currentTag || 'unknown')} ${dim('→')} ${cyan(latest.tag)}\n`,
    );
    finishSuccessHint();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface LatestRelease {
  tag: string;
  publishedAt: string;
  assetName: string;
  assetUrl: string;
  assetSize: number;
}

/**
 * Query `GET /repos/<owner>/<repo>/releases/latest`, return the first asset
 * whose filename ends in `.tar.gz`. Throws with a useful message if there
 * are no releases yet or no tarball asset attached.
 */
async function fetchLatestRelease(repo: string): Promise<LatestRelease> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'andybioticlaw-update',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub API ${res.status} for ${url}: ${body.slice(0, 200) || '(empty body)'}`,
    );
  }
  const json = (await res.json()) as {
    tag_name?: string;
    published_at?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  if (!json.tag_name) {
    throw new Error(`no tag_name on ${url} response — is a release published?`);
  }
  const tar = json.assets?.find((a) => a.name.endsWith('.tar.gz'));
  if (!tar) {
    throw new Error(
      `no .tar.gz asset on release ${json.tag_name} — attach one or cut a new release via CI`,
    );
  }
  return {
    tag: json.tag_name,
    publishedAt: json.published_at ?? 'unknown',
    assetName: tar.name,
    assetUrl: tar.browser_download_url,
    assetSize: tar.size,
  };
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`download failed: empty body for ${url}`);
  // fetch's body is a web ReadableStream; Readable.fromWeb bridges to node.
  // Pipe directly to disk so we don't buffer the whole tarball in memory.
  const fileStream = createWriteStream(destPath);
  const webBody = res.body as unknown as ReadableStream;
  await new Promise<void>((resolveDownload, rejectDownload) => {
    Readable.fromWeb(webBody)
      .on('error', rejectDownload)
      .pipe(fileStream)
      .on('finish', () => resolveDownload())
      .on('error', rejectDownload);
  });
}

/** The tarball's top-level directory looks like `andybioticlaw-v0.2.0/`;
 *  find it inside the staging dir so we can point rsync at it. */
function findExtractedRoot(staging: string): string | null {
  const entries = readdirSync(staging, { withFileTypes: true });
  const dir = entries.find(
    (e) => e.isDirectory() && e.name.startsWith('andybioticlaw-'),
  );
  return dir ? resolve(staging, dir.name) : null;
}

// ---------------------------------------------------------------------------
// package.json helpers (exported for testing)
// ---------------------------------------------------------------------------

interface PackageJson {
  version?: string;
  repository?: string | { type?: string; url?: string };
}

function readPackageJson(root: string): PackageJson {
  const path = resolve(root, 'package.json');
  if (!existsSync(path)) {
    throw new Error(`package.json not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/**
 * Extract the `<owner>/<repo>` slug from a `repository.url` field, coping
 * with the variety of formats npm accepts:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git+https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   owner/repo                            (shorthand)
 *
 * Exported so unit tests can exercise the parser without touching disk.
 */
export function parseGithubRepo(pkg: PackageJson): string {
  const raw =
    typeof pkg.repository === 'string'
      ? pkg.repository
      : (pkg.repository?.url ?? '');
  if (!raw) {
    throw new Error(
      'package.json is missing `repository.url` — cannot determine where to fetch releases from',
    );
  }
  // Short form: "owner/repo".
  const short = raw.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (short) return `${short[1]}/${short[2]}`;
  // Long form: any URL containing github.com.
  const m = raw.match(/github\.com[:/]([^/]+)\/([^/.?#]+?)(?:\.git)?(?:[?#/].*)?$/);
  if (!m) {
    throw new Error(`could not parse github owner/repo from: ${raw}`);
  }
  return `${m[1]}/${m[2]}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function finishSuccessHint(): void {
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

function runSync(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    // pnpm in non-TTY contexts (sudo -iu wrapped commands) refuses to
    // auto-purge an out-of-date node_modules with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. Setting CI=true is
    // pnpm's own documented escape hatch — it then assumes "yes" to
    // the purge prompt.
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

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Best-effort comparison: did `systemd/*.template` change in a way that
 * the installed `/etc/systemd/system/andybioticlaw.service` no longer
 * reflects? We can't sudo read that file from an unprivileged process,
 * so we check whether the template references a placeholder the
 * shipped installer isn't aware of and hint at a re-install if so.
 */
function detectSystemdDrift(root: string): string | null {
  const tpl = resolve(root, 'systemd', 'andybioticlaw.service.template');
  if (!existsSync(tpl)) return null;
  try {
    const tplBody = readFileSync(tpl, 'utf8');
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
