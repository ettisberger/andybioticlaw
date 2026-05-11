import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readGitMetadata } from '../../src/projects/git-introspection.js';

/**
 * These tests use a real `git` binary in a tmpdir — simpler and more
 * reliable than mocking exec output, and `git` is a near-universal
 * dev/CI dependency. If the binary isn't on PATH, the tests fail loudly
 * (the readGitMetadata path also fails loudly in that case at runtime,
 * which is the behaviour we want to verify works).
 */

function git(repo: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

describe('readGitMetadata', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-git-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null lastCommit + branch null on a fresh repo with no commits', async () => {
    const m = await readGitMetadata({ repoPath: dir });
    expect(m.lastCommit).toBeNull();
    expect(m.daysSinceLastCommit).toBeNull();
    // `git rev-parse --abbrev-ref HEAD` on an empty repo errors, so
    // branch ends up null. Also remoteUrl null. Not dirty.
    expect(m.branch).toBeNull();
    expect(m.remoteUrl).toBeNull();
    expect(m.isDirty).toBe(false);
  });

  it('captures branch + last commit on a repo with one commit', async () => {
    writeFileSync(resolve(dir, 'README.md'), 'hello');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial commit');

    const m = await readGitMetadata({ repoPath: dir });
    expect(m.branch).toBe('main');
    expect(m.lastCommit).not.toBeNull();
    expect(m.lastCommit!.subject).toBe('initial commit');
    expect(m.lastCommit!.author).toBe('Test');
    expect(m.lastCommit!.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(m.lastCommit!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.daysSinceLastCommit).toBe(0); // just-committed
    expect(m.isDirty).toBe(false);
    expect(m.remoteUrl).toBeNull();
    expect(m.errors).toEqual({});
  });

  it('isDirty=true when working tree has uncommitted changes', async () => {
    writeFileSync(resolve(dir, 'README.md'), 'hello');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
    writeFileSync(resolve(dir, 'README.md'), 'changed');

    const m = await readGitMetadata({ repoPath: dir });
    expect(m.isDirty).toBe(true);
  });

  it('captures remoteUrl when origin is configured', async () => {
    git(dir, 'remote', 'add', 'origin', 'git@github.com:foo/bar.git');
    const m = await readGitMetadata({ repoPath: dir });
    expect(m.remoteUrl).toBe('git@github.com:foo/bar.git');
  });

  it('treats missing origin as null (not an error)', async () => {
    const m = await readGitMetadata({ repoPath: dir });
    expect(m.remoteUrl).toBeNull();
    expect(m.errors.remoteUrl).toBeUndefined();
  });

  it('computes daysSinceLastCommit using injected `now`', async () => {
    writeFileSync(resolve(dir, 'README.md'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'old');

    // 10 days in the future
    const tenDaysLater = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const m = await readGitMetadata({
      repoPath: dir,
      now: () => tenDaysLater,
    });
    expect(m.daysSinceLastCommit).toBe(10);
  });

  it('records errors per-call without poisoning successful fields', async () => {
    // Pass a path that exists but isn't a git repo. The git calls all
    // fail, but the function still returns a structured result rather
    // than throwing.
    const nonRepo = mkdtempSync(resolve(tmpdir(), 'andy-non-git-'));
    try {
      const m = await readGitMetadata({ repoPath: nonRepo });
      expect(m.branch).toBeNull();
      expect(m.lastCommit).toBeNull();
      expect(m.isDirty).toBe(false);
      // At minimum the branch + status calls should have errored
      expect(Object.keys(m.errors).length).toBeGreaterThan(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
