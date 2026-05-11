import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface GitLastCommit {
  /** Short SHA (7 chars). */
  sha: string;
  /** ISO 8601 date string from `%cI`. */
  date: string;
  /** Commit subject line. */
  subject: string;
  /** Author name from `%an`. */
  author: string;
}

export interface GitMetadata {
  /** Current branch, or `null` if HEAD is detached / no commits yet. */
  branch: string | null;
  /** Most recent commit, or `null` if the repo has no commits. */
  lastCommit: GitLastCommit | null;
  /** `origin` remote URL, or `null` if no `origin` is configured. */
  remoteUrl: string | null;
  /** True iff `git status --porcelain` returned anything. */
  isDirty: boolean;
  /** Days since the last commit (whole number, floor). `null` if no commits. */
  daysSinceLastCommit: number | null;
  /** Per-call errors keyed by which subcommand failed. Empty when all succeeded. */
  errors: Record<string, string>;
}

export interface GitIntrospectionOptions {
  /** Absolute path to the git repository. */
  repoPath: string;
  /** Per-git-call timeout. Defaults to 5 seconds. */
  timeoutMs?: number;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Common flags for every `git` invocation:
 * - `--no-pager`            — never page output (we capture stdout).
 * - `-c color.ui=never`     — strip ANSI in case .gitconfig forces it.
 * - `-c core.fsmonitor=false` — defensive; some setups have a slow fsmonitor
 *                               hook that adds seconds to status calls.
 *
 * `--no-optional-locks` only applies to subcommands that take a lock
 * (status, fetch, …); it's harmless on the others.
 */
const GIT_BASE_ARGS = [
  '--no-pager',
  '-c',
  'color.ui=never',
  '-c',
  'core.fsmonitor=false',
  '--no-optional-locks',
];

async function runGit(
  repoPath: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await pexec('git', ['-C', repoPath, ...GIT_BASE_ARGS, ...args], {
    timeout: timeoutMs,
    // Keep memory bounded — even `git log -1` can be a few KB on long
    // commit messages; 1 MiB is plenty and protects against runaway output.
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Read git metadata for one repo. Each subcommand runs in parallel and
 * is independently isolated — a failure in one (e.g. detached HEAD →
 * branch name lookup fails) doesn't poison the others. Failed fields
 * are returned as `null` and the error message is recorded in `errors`.
 *
 * Pure: no logging, no caching, no fs side-effects beyond what git
 * itself touches. Caller decides what to do with errors.
 */
export async function readGitMetadata(
  opts: GitIntrospectionOptions,
): Promise<GitMetadata> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  const [branchR, commitR, remoteR, statusR] = await Promise.allSettled([
    runGit(opts.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs),
    // Field separator: `%x1f` is the ASCII Unit Separator (0x1f). It will
    // never appear in a sha / date / author / commit subject under any
    // reasonable input, so we can split on it without escaping headaches.
    runGit(
      opts.repoPath,
      ['log', '-1', '--format=%h%x1f%cI%x1f%an%x1f%s'],
      timeoutMs,
    ),
    runGit(opts.repoPath, ['remote', 'get-url', 'origin'], timeoutMs),
    runGit(opts.repoPath, ['status', '--porcelain'], timeoutMs),
  ]);

  const errors: Record<string, string> = {};

  // Branch
  let branch: string | null = null;
  if (branchR.status === 'fulfilled') {
    const trimmed = branchR.value.trim();
    // `git rev-parse --abbrev-ref HEAD` returns 'HEAD' when detached.
    branch = trimmed === 'HEAD' || trimmed === '' ? null : trimmed;
  } else {
    errors.branch = (branchR.reason as Error).message;
  }

  // Last commit
  let lastCommit: GitLastCommit | null = null;
  let daysSinceLastCommit: number | null = null;
  if (commitR.status === 'fulfilled') {
    const line = commitR.value.replace(/\n$/, '');
    if (line) {
      const parts = line.split('');
      if (parts.length >= 4) {
        lastCommit = {
          sha: parts[0]!,
          date: parts[1]!,
          author: parts[2]!,
          subject: parts.slice(3).join(''),
        };
        const ts = Date.parse(lastCommit.date);
        if (!Number.isNaN(ts)) {
          const ms = now() - ts;
          daysSinceLastCommit = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
        }
      } else {
        errors.lastCommit = `unexpected format: ${parts.length} fields`;
      }
    }
    // Empty stdout = repo has no commits yet (fresh `git init`). Not
    // an error — leave lastCommit null.
  } else {
    // Empty repo (no commits) makes `git log` exit 128 too; record but
    // don't alarm — caller treats null as "unknown / no commits".
    errors.lastCommit = (commitR.reason as Error).message;
  }

  // Remote URL
  let remoteUrl: string | null = null;
  if (remoteR.status === 'fulfilled') {
    const trimmed = remoteR.value.trim();
    remoteUrl = trimmed === '' ? null : trimmed;
  } else {
    // Missing `origin` exits 128. Surface it as null, not as an error,
    // because "no remote configured" is a normal repo state.
    const msg = (remoteR.reason as Error).message;
    if (!/No such remote|origin/i.test(msg)) {
      errors.remoteUrl = msg;
    }
  }

  // Dirty
  let isDirty = false;
  if (statusR.status === 'fulfilled') {
    isDirty = statusR.value.trim().length > 0;
  } else {
    errors.isDirty = (statusR.reason as Error).message;
  }

  return {
    branch,
    lastCommit,
    remoteUrl,
    isDirty,
    daysSinceLastCommit,
    errors,
  };
}
