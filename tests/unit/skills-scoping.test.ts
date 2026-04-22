import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { loadSkills } from '../../src/skills/loader.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';
import {
  createSecretsManager,
  envSecretsStore,
  staticSkillPermissions,
  SecretScopeViolationError,
} from '../../src/config/secrets.js';

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

/**
 * Phase 3 done-criterion check: skill A cannot read a secret declared only by
 * skill B. Verified end-to-end against the real manifest loader + registry +
 * secrets manager, with an audit row confirming the violation.
 */
describe('secret scoping across loaded skills', () => {
  let skillsDir: string;
  const logger = pino({ level: 'silent' });
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    skillsDir = mkdtempSync(resolve(tmpdir(), 'andy-scope-'));
    for (const k of ['SKILL_A_SECRET', 'SKILL_B_SECRET']) {
      if (!saved.has(k)) saved.set(k, process.env[k]);
    }
    process.env.SKILL_A_SECRET = 'A-value';
    process.env.SKILL_B_SECRET = 'B-value';
  });

  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function writeSkill(name: string, requiredSecrets: string[]) {
    const dir = resolve(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'manifest.yaml'),
      [
        `name: ${name}`,
        `version: 0.1.0`,
        `description: test`,
        `enabled: true`,
        `scope: [dm]`,
        `required_secrets: [${requiredSecrets.join(', ')}]`,
      ].join('\n'),
    );
    writeFileSync(resolve(dir, 'SKILL.md'), `# ${name}`);
  }

  it('skill A reads only its own declared secret; reading B throws and audits', () => {
    writeSkill('skill-a', ['SKILL_A_SECRET']);
    writeSkill('skill-b', ['SKILL_B_SECRET']);
    const db = makeDb();
    const audit = createAuditRepo(db);
    const registry = createSkillRegistry(db);
    loadSkills({ dir: skillsDir, logger, registry });

    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(registry.requiredSecretsTable()),
      audit,
    });

    // Skill A may read its own secret.
    expect(secrets.getSecret('SKILL_A_SECRET', { skill: 'skill-a' })).toBe('A-value');

    // Skill A may NOT read skill B's secret — must throw + audit.
    expect(() => secrets.getSecret('SKILL_B_SECRET', { skill: 'skill-a' })).toThrow(
      SecretScopeViolationError,
    );
    const rows = audit.list({ kind: 'secret_scope_violation' });
    expect(rows.length).toBeGreaterThan(0);
    const detail = rows[0]!.detail as { secretName?: string } | null;
    expect(detail?.secretName).toBe('SKILL_B_SECRET');
  });

  it('core scope cannot read any skill secret', () => {
    writeSkill('skill-a', ['SKILL_A_SECRET']);
    const db = makeDb();
    const audit = createAuditRepo(db);
    const registry = createSkillRegistry(db);
    loadSkills({ dir: skillsDir, logger, registry });

    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(registry.requiredSecretsTable()),
      audit,
    });
    expect(() => secrets.getSecret('SKILL_A_SECRET', 'core')).toThrow(
      SecretScopeViolationError,
    );
  });
});
