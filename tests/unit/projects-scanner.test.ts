import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { scanProjects } from '../../src/projects/scanner.js';

const SILENT_LOGGER = pino({ level: 'silent' });

describe('scanProjects', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-projects-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeProject(name: string, files: string[] = []): string {
    const p = resolve(dir, name);
    mkdirSync(p, { recursive: true });
    for (const f of files) {
      writeFileSync(resolve(p, f), '');
    }
    return p;
  }

  it('returns the empty result when folder is missing', () => {
    const r = scanProjects({
      folderPath: resolve(dir, 'does-not-exist'),
      logger: SILENT_LOGGER,
    });
    expect(r.projects).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/not found/);
  });

  it('lists folders as projects, capturing markers', () => {
    makeProject('momentra', ['Dockerfile', 'package.json']);
    makeProject('cognitek', ['Dockerfile', 'README.md']);
    makeProject('paperpapi', ['package.json']);

    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    expect(r.projects).toHaveLength(3);

    const byName = Object.fromEntries(r.projects.map((p) => [p.name, p]));
    expect(byName.momentra!.markers.hasDockerfile).toBe(true);
    expect(byName.momentra!.markers.hasPackageJson).toBe(true);
    expect(byName.momentra!.markers.hasReadme).toBe(false);
    expect(byName.cognitek!.markers.hasReadme).toBe(true);
    expect(byName.paperpapi!.markers.hasDockerfile).toBe(false);
  });

  it('skips dotfile-prefixed entries silently', () => {
    makeProject('real-project');
    makeProject('.DS_Store-folder');
    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    expect(r.projects.map((p) => p.name)).toEqual(['real-project']);
    // Dotfile skip is silent — it's noise we never want to surface.
    expect(r.skipped.find((s) => s.name === '.DS_Store-folder')).toBeUndefined();
  });

  it('skips underscore-prefixed entries with a recorded reason', () => {
    makeProject('real-project');
    makeProject('_infra');
    makeProject('_template');
    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    expect(r.projects.map((p) => p.name)).toEqual(['real-project']);
    expect(r.skipped.map((s) => s.name).sort()).toEqual(['_infra', '_template']);
    expect(r.skipped[0]!.reason).toMatch(/underscore/);
  });

  it('skips non-directory entries (loose files in projects folder)', () => {
    makeProject('a-project');
    writeFileSync(resolve(dir, 'README.md'), '# workspace');
    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    expect(r.projects.map((p) => p.name)).toEqual(['a-project']);
    expect(r.skipped.find((s) => s.name === 'README.md')).toBeDefined();
  });

  it('detects .git as making the project a git repo', () => {
    const p = makeProject('with-git');
    mkdirSync(resolve(p, '.git'));
    makeProject('without-git');
    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    const byName = Object.fromEntries(r.projects.map((p) => [p.name, p]));
    expect(byName['with-git']!.isGitRepo).toBe(true);
    expect(byName['without-git']!.isGitRepo).toBe(false);
  });

  it('follows symlinked folder paths and reports the resolved root', () => {
    const real = mkdtempSync(resolve(tmpdir(), 'andy-real-'));
    try {
      mkdirSync(resolve(real, 'inside'));
      const linkPath = resolve(dir, 'link-to-real');
      symlinkSync(real, linkPath);
      const r = scanProjects({
        folderPath: linkPath,
        logger: SILENT_LOGGER,
      });
      // rootPath is the realpath, not the symlink target
      expect(r.rootPath).not.toContain('link-to-real');
      expect(r.projects.map((p) => p.name)).toEqual(['inside']);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('detects multiple language markers per project', () => {
    makeProject('polyglot', [
      'Dockerfile',
      'package.json',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'README.md',
    ]);
    const r = scanProjects({ folderPath: dir, logger: SILENT_LOGGER });
    const m = r.projects[0]!.markers;
    expect(m).toEqual({
      hasDockerfile: true,
      hasPackageJson: true,
      hasRequirementsTxt: true,
      hasGoMod: true,
      hasCargoToml: true,
      hasReadme: true,
    });
  });
});
