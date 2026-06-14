import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readSkillManifestForApt } from '../../src/skills/apt-deps-helper.js';

describe('readSkillManifestForApt', () => {
  let skillsRoot: string;

  beforeEach(() => {
    skillsRoot = mkdtempSync(resolve(tmpdir(), 'andy-apt-helper-'));
  });
  afterEach(() => {
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  function writeManifest(name: string, body: string): void {
    const dir = resolve(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'manifest.yaml'), body);
  }

  it('returns the apt list for a well-formed manifest', () => {
    writeManifest(
      'browser',
      'name: browser\nversion: 0.1.0\ndescription: x\napt_dependencies:\n  - libnss3\n  - libxkbcommon0\n',
    );
    const r = readSkillManifestForApt('browser', skillsRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.aptDependencies).toEqual(['libnss3', 'libxkbcommon0']);
    }
  });

  it('returns an empty list when apt_dependencies is missing', () => {
    writeManifest('notes', 'name: notes\nversion: 0.1.0\ndescription: x\n');
    const r = readSkillManifestForApt('notes', skillsRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.aptDependencies).toEqual([]);
  });

  it('returns an empty list when apt_dependencies is explicit []', () => {
    writeManifest(
      'hue',
      'name: hue\nversion: 0.1.0\ndescription: x\napt_dependencies: []\n',
    );
    const r = readSkillManifestForApt('hue', skillsRoot);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.aptDependencies).toEqual([]);
  });

  it('returns not-found for an unknown skill', () => {
    const r = readSkillManifestForApt('does-not-exist', skillsRoot);
    expect(r.kind).toBe('not-found');
    if (r.kind === 'not-found') expect(r.skillsDir).toBe(skillsRoot);
  });

  it('returns invalid-manifest for malformed YAML', () => {
    writeManifest('broken', ':::not valid yaml\n  -[unbalanced');
    const r = readSkillManifestForApt('broken', skillsRoot);
    expect(r.kind).toBe('invalid-manifest');
  });

  it('returns invalid-manifest when apt_dependencies is not an array', () => {
    writeManifest(
      'wrongshape',
      'name: wrongshape\nversion: 0.1.0\napt_dependencies: not-an-array\n',
    );
    const r = readSkillManifestForApt('wrongshape', skillsRoot);
    expect(r.kind).toBe('invalid-manifest');
    if (r.kind === 'invalid-manifest') {
      expect(r.error).toMatch(/array/);
    }
  });

  it('returns invalid-manifest when an apt entry is not a string', () => {
    writeManifest(
      'mixedtypes',
      'name: mixedtypes\nversion: 0.1.0\napt_dependencies:\n  - libnss3\n  - 42\n',
    );
    const r = readSkillManifestForApt('mixedtypes', skillsRoot);
    expect(r.kind).toBe('invalid-manifest');
  });
});
