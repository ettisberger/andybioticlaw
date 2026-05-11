import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Logger } from 'pino';

/**
 * One marker file = one boolean. Used to colour the project list with
 * a "this looks like a node app / docker image / etc." hint without any
 * deep introspection. The set is intentionally small: adding more
 * markers means more `existsSync` calls per project per scan.
 */
export interface ProjectMarkers {
  hasDockerfile: boolean;
  hasPackageJson: boolean;
  hasRequirementsTxt: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasReadme: boolean;
}

export interface ProjectRecord {
  /** Folder name (basename), used as the project's display id. */
  name: string;
  /** Resolved absolute path (symlinks followed). */
  path: string;
  /** True iff `<path>/.git` exists. Drives whether to call git later. */
  isGitRepo: boolean;
  markers: ProjectMarkers;
}

export interface ScanResult {
  /** Resolved root folder we scanned (with `~` expanded + symlinks followed). */
  rootPath: string;
  /** All project folders found, in directory-order. */
  projects: ProjectRecord[];
  /** Skipped entries (dotfile-prefixed, underscore-prefixed, non-dirs). */
  skipped: Array<{ name: string; reason: string }>;
  /** Per-folder failures (permission denied, etc.). Other folders still render. */
  failed: Array<{ name: string; error: string }>;
  /** Top-level scan warnings the page should surface as a banner. */
  warnings: string[];
}

export interface ScanOptions {
  /** Configured folder path. May contain `~` and may be a symlink. */
  folderPath: string;
  logger: Logger;
}

/**
 * Expand a leading `~` to the user's home dir, then resolve to an
 * absolute path. Does NOT call realpath() — that's deferred until we
 * know the path exists.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Scan a folder for project subdirectories. Per-folder failures are
 * isolated so one bad folder doesn't crash the page (mirrors the
 * `loadSkills` contract in src/skills/loader.ts).
 *
 * No git work happens here — `git-introspection.ts` enriches each
 * `isGitRepo: true` record separately. Keeping the scan pure means
 * the unit tests don't need a real git binary.
 */
export function scanProjects(opts: ScanOptions): ScanResult {
  const result: ScanResult = {
    rootPath: '',
    projects: [],
    skipped: [],
    failed: [],
    warnings: [],
  };

  const expanded = expandHome(opts.folderPath);
  if (!existsSync(expanded)) {
    result.rootPath = expanded;
    result.warnings.push(`projects folder not found: ${expanded}`);
    opts.logger.warn(
      { folderPath: opts.folderPath, expanded },
      'projects folder missing — 0 projects scanned',
    );
    return result;
  }

  // Symlinks (e.g. ~/projects → /srv/projects) are followed so the
  // dashboard shows the real on-disk location. Wrapped in try because
  // realpath can throw on broken symlinks even after existsSync said yes.
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(expanded);
  } catch (e) {
    result.rootPath = expanded;
    result.warnings.push(
      `failed to resolve projects folder: ${(e as Error).message}`,
    );
    return result;
  }
  result.rootPath = resolvedRoot;

  let entries: string[];
  try {
    entries = readdirSync(resolvedRoot);
  } catch (e) {
    result.warnings.push(
      `failed to read projects folder: ${(e as Error).message}`,
    );
    return result;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      // Dotfiles are noise (.DS_Store, .git in a flat workspace, …) —
      // silent skip rather than cluttering the skipped list.
      continue;
    }
    if (entry.startsWith('_')) {
      // Matches the `_template`/`_<reserved>` convention in
      // src/skills/loader.ts:70-73 — used by the operator for
      // workspace-local infra (e.g. `_infra/caddy`) that isn't a project.
      result.skipped.push({ name: entry, reason: 'underscore-prefixed (reserved)' });
      continue;
    }

    const full = resolve(resolvedRoot, entry);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) {
        result.skipped.push({ name: entry, reason: 'not a directory' });
        continue;
      }
    } catch (e) {
      result.failed.push({ name: entry, error: (e as Error).message });
      continue;
    }

    try {
      // Per-marker existsSync is cheap; six syscalls per project is a
      // rounding error compared to the git work that follows. Probing
      // for files (not directories) so empty markers (`touch Dockerfile`)
      // still count.
      const markers: ProjectMarkers = {
        hasDockerfile: existsSync(resolve(full, 'Dockerfile')),
        hasPackageJson: existsSync(resolve(full, 'package.json')),
        hasRequirementsTxt: existsSync(resolve(full, 'requirements.txt')),
        hasGoMod: existsSync(resolve(full, 'go.mod')),
        hasCargoToml: existsSync(resolve(full, 'Cargo.toml')),
        hasReadme:
          existsSync(resolve(full, 'README.md')) ||
          existsSync(resolve(full, 'README')) ||
          existsSync(resolve(full, 'readme.md')),
      };
      const isGitRepo = existsSync(resolve(full, '.git'));

      result.projects.push({
        name: entry,
        path: full,
        isGitRepo,
        markers,
      });
    } catch (e) {
      result.failed.push({ name: entry, error: (e as Error).message });
    }
  }

  opts.logger.debug(
    {
      rootPath: result.rootPath,
      projects: result.projects.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    'projects scan complete',
  );
  return result;
}
