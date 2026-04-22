import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { loadSkills } from '../../src/skills/loader.js';
import { createSkillRegistry } from '../../src/skills/registry.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      resolve(__dirname, '..', '..', 'src', 'db', 'migrations', '0001_init.sql'),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      resolve(
        __dirname,
        '..',
        '..',
        'src',
        'db',
        'migrations',
        '0002_memory_proposals_skill_state.sql',
      ),
      'utf8',
    ),
  );
  return db;
}

describe('skill loader', () => {
  const logger = pino({ level: 'silent' });
  let skillsDir: string;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    skillsDir = mkdtempSync(resolve(tmpdir(), 'andy-skills-'));
    db = makeDb();
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  function writeSkill(
    name: string,
    manifestBody: string,
    skillMdBody = '# skill',
  ) {
    const dir = resolve(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'manifest.yaml'), manifestBody);
    writeFileSync(resolve(dir, 'SKILL.md'), skillMdBody);
  }

  it('loads a well-formed skill and registers it', () => {
    writeSkill(
      'calendar',
      `
name: calendar
version: 0.1.0
description: Google Calendar reader
enabled: true
scope:
  - dm
required_secrets:
  - GOOGLE_OAUTH_TOKEN
mcp_servers:
  - name: google-calendar
    command: node
    args: [./mcp-server.js]
    env:
      GOOGLE_OAUTH_TOKEN: \${GOOGLE_OAUTH_TOKEN}
`,
    );
    const registry = createSkillRegistry(db);
    const result = loadSkills({ dir: skillsDir, logger, registry });
    expect(result.loaded).toBe(1);
    expect(result.failed).toHaveLength(0);
    const rec = registry.get('calendar');
    expect(rec).toBeDefined();
    expect(rec!.requiredSecrets).toEqual(['GOOGLE_OAUTH_TOKEN']);
    expect(rec!.mcpServers).toHaveLength(1);
    expect(rec!.mcpServers[0]!.name).toBe('google-calendar');
  });

  it('skips underscore-prefixed folders', () => {
    writeSkill('_template', `name: _template\nversion: 0.0.0\ndescription: tpl\nenabled: false\nscope: [dm]`);
    const registry = createSkillRegistry(db);
    const result = loadSkills({ dir: skillsDir, logger, registry });
    expect(result.loaded).toBe(0);
    expect(result.skipped.some((s) => s.name === '_template')).toBe(true);
  });

  it('fails a skill with mismatched name vs folder', () => {
    writeSkill(
      'real-name',
      `name: other-name\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [dm]`,
    );
    const registry = createSkillRegistry(db);
    const result = loadSkills({ dir: skillsDir, logger, registry });
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/does not match folder/);
  });

  it('rejects non-kebab skill names', () => {
    writeSkill('Upper_Case', `name: Upper_Case\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [dm]`);
    const registry = createSkillRegistry(db);
    const result = loadSkills({ dir: skillsDir, logger, registry });
    expect(result.failed).toHaveLength(1);
  });

  it('rejects bad secret names (must be UPPER_SNAKE)', () => {
    writeSkill(
      'noisy',
      `name: noisy\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [dm]\nrequired_secrets: [lowercase]`,
    );
    const registry = createSkillRegistry(db);
    const result = loadSkills({ dir: skillsDir, logger, registry });
    expect(result.failed).toHaveLength(1);
  });

  it('activeFor respects enabled flag and scope', () => {
    writeSkill('a', `name: a\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [dm]`);
    writeSkill('b', `name: b\nversion: 0.1.0\ndescription: x\nenabled: false\nscope: [dm]`);
    writeSkill('c', `name: c\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [group]`);
    const registry = createSkillRegistry(db);
    loadSkills({ dir: skillsDir, logger, registry });
    const dmActive = registry.activeFor('dm').map((s) => s.name).sort();
    expect(dmActive).toEqual(['a']);
    const grpActive = registry.activeFor('group').map((s) => s.name).sort();
    expect(grpActive).toEqual(['c']);
  });

  it('DB override of enable state wins over manifest', () => {
    writeSkill('a', `name: a\nversion: 0.1.0\ndescription: x\nenabled: true\nscope: [dm]`);
    const registry = createSkillRegistry(db);
    loadSkills({ dir: skillsDir, logger, registry });
    expect(registry.get('a')!.enabled).toBe(true);
    registry.setEnabled('a', false);
    expect(registry.get('a')!.enabled).toBe(false);
    // Re-scan: persisted state should still apply.
    loadSkills({ dir: skillsDir, logger, registry });
    expect(registry.get('a')!.enabled).toBe(false);
  });
});
