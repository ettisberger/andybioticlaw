import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applySkillTemplating } from '../../src/skills/templating.js';

describe('applySkillTemplating', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-tpl-'));
    configPath = resolve(dir, 'config.yaml');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes through content for non-browser skills', () => {
    const out = applySkillTemplating({
      skillName: 'notes',
      content: 'something with {{profiles}} placeholder',
      configPath,
    });
    expect(out).toContain('{{profiles}}');
  });

  it('passes through browser content with no placeholder', () => {
    const out = applySkillTemplating({
      skillName: 'browser',
      content: 'plain text, no template',
      configPath,
    });
    expect(out).toBe('plain text, no template');
  });

  it('substitutes a bullet list for {{profiles}}', () => {
    writeFileSync(
      configPath,
      `browser:\n  profiles:\n    - name: gmail\n      description: ProtonMail\n    - name: github\n`,
    );
    const out = applySkillTemplating({
      skillName: 'browser',
      content: 'before\n{{profiles}}\nafter',
      configPath,
    });
    expect(out).toContain('- `gmail` — ProtonMail');
    expect(out).toContain('- `github`');
    expect(out).not.toContain('{{profiles}}');
  });

  it('falls back to a fixed message when no profiles configured', () => {
    writeFileSync(configPath, `browser:\n  profiles: []\n`);
    const out = applySkillTemplating({
      skillName: 'browser',
      content: '{{profiles}}',
      configPath,
    });
    expect(out).toContain('no profiles configured');
  });

  it('falls back when the config file is missing', () => {
    const out = applySkillTemplating({
      skillName: 'browser',
      content: '{{profiles}}',
      configPath: resolve(dir, 'missing.yaml'),
    });
    expect(out).toContain('no profiles configured');
  });

  it('falls back on YAML parse error rather than throwing', () => {
    writeFileSync(configPath, `:::not valid yaml\n  - [unbalanced`);
    const out = applySkillTemplating({
      skillName: 'browser',
      content: '{{profiles}}',
      configPath,
    });
    // Either fallback message is acceptable — we just must not throw.
    expect(typeof out).toBe('string');
    expect(out).not.toContain('{{profiles}}');
  });
});
