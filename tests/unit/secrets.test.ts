import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createSecretsManager,
  envSecretsStore,
  staticSkillPermissions,
  SecretScopeViolationError,
  CORE_SECRETS,
} from '../../src/config/secrets.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT,
      detail TEXT
    );
  `);
  return db;
}

describe('secrets scoping', () => {
  let origToken: string | undefined;
  let origSkillA: string | undefined;
  let origCct: string | undefined;

  beforeEach(() => {
    origToken = process.env.TELEGRAM_BOT_TOKEN;
    origSkillA = process.env.SKILL_A_SECRET;
    origCct = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-core-token';
    process.env.SKILL_A_SECRET = 'dummy-skill-a';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-dummy';
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = origToken;
    if (origSkillA === undefined) delete process.env.SKILL_A_SECRET;
    else process.env.SKILL_A_SECRET = origSkillA;
    if (origCct === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = origCct;
  });

  it('core can read allowlisted core secrets', () => {
    const db = makeDb();
    const audit = createAuditRepo(db);
    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(new Map()),
      audit,
    });
    expect(CORE_SECRETS).toContain('TELEGRAM_BOT_TOKEN');
    expect(CORE_SECRETS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(secrets.getSecret('TELEGRAM_BOT_TOKEN', 'core')).toBe('dummy-core-token');
    expect(secrets.getSecret('CLAUDE_CODE_OAUTH_TOKEN', 'core')).toBe('sk-ant-oat-dummy');
  });

  it('skill cannot read the core claude-code-oauth-token', () => {
    const db = makeDb();
    const audit = createAuditRepo(db);
    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(new Map([['skill-a', ['SKILL_A_SECRET']]])),
      audit,
    });
    expect(() =>
      secrets.getSecret('CLAUDE_CODE_OAUTH_TOKEN', { skill: 'skill-a' }),
    ).toThrow(SecretScopeViolationError);
    const rows = audit.list();
    expect(rows[0]?.kind).toBe('secret_scope_violation');
  });

  it('core cannot read a skill secret', () => {
    const db = makeDb();
    const audit = createAuditRepo(db);
    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(new Map([['skill-a', ['SKILL_A_SECRET']]])),
      audit,
    });
    expect(() => secrets.getSecret('SKILL_A_SECRET', 'core')).toThrow(SecretScopeViolationError);
    const rows = audit.list();
    expect(rows[0]?.kind).toBe('secret_scope_violation');
  });

  it('skill A cannot read skill B secret', () => {
    const db = makeDb();
    const audit = createAuditRepo(db);
    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(
        new Map([
          ['skill-a', ['SKILL_A_SECRET']],
          ['skill-b', ['SKILL_B_SECRET']],
        ]),
      ),
      audit,
    });
    expect(() => secrets.getSecret('SKILL_B_SECRET', { skill: 'skill-a' })).toThrow(
      SecretScopeViolationError,
    );
  });

  it('skill A can read its own declared secret', () => {
    const db = makeDb();
    const audit = createAuditRepo(db);
    const secrets = createSecretsManager({
      store: envSecretsStore(),
      skills: staticSkillPermissions(new Map([['skill-a', ['SKILL_A_SECRET']]])),
      audit,
    });
    expect(secrets.getSecret('SKILL_A_SECRET', { skill: 'skill-a' })).toBe('dummy-skill-a');
  });
});
