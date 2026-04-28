import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSkillRegistry } from '../../src/skills/registry.js';
import type { SkillRecord } from '../../src/skills/registry.js';

/**
 * Pin the per-agent + per-policy skill filter so the
 * `agent.skills × policy.skillsVisible` intersection is enforced
 * exactly. This is the gate that constrains what an agent in a
 * specific context can see — silent failure here = a setting that
 * looks like enforcement but isn't.
 */

function makeSkill(name: string, opts: Partial<SkillRecord> = {}): SkillRecord {
  return {
    name,
    version: '0.1.0',
    description: `${name} skill`,
    enabled: true,
    scope: ['dm', 'group'],
    requiredSecrets: [],
    aptDependencies: [],
    systemCommands: [],
    mcpServers: [],
    execAllow: [],
    manifestPath: `/tmp/${name}/manifest.yaml`,
    skillMdPath: `/tmp/${name}/SKILL.md`,
    skillDir: `/tmp/${name}`,
    ...opts,
  };
}

describe('SkillRegistry.activeForAgent — agent.skills × policy.skillsVisible', () => {
  let db: Database.Database;
  let registry: ReturnType<typeof createSkillRegistry>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE skill_state (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at INTEGER NOT NULL,
        last_install_output TEXT,
        last_enabled_at INTEGER,
        last_disabled_at INTEGER
      );
    `);
    registry = createSkillRegistry(db);
    registry.register(makeSkill('memory'));
    registry.register(makeSkill('notes'));
    registry.register(makeSkill('himalaya'));
    registry.register(makeSkill('hue'));
  });

  afterEach(() => db.close());

  it('returns ALL enabled skills when both filters are wildcards', () => {
    const out = registry.activeForAgent('dm', ['*'], ['*']);
    expect(out.map((s) => s.name).sort()).toEqual([
      'himalaya',
      'hue',
      'memory',
      'notes',
    ]);
  });

  it('narrows to the agent.skills explicit list', () => {
    const out = registry.activeForAgent('dm', ['memory', 'notes'], ['*']);
    expect(out.map((s) => s.name).sort()).toEqual(['memory', 'notes']);
  });

  it('narrows to the policy.skillsVisible explicit list', () => {
    const out = registry.activeForAgent('dm', ['*'], ['memory']);
    expect(out.map((s) => s.name)).toEqual(['memory']);
  });

  it('intersects agent.skills AND policy.skillsVisible', () => {
    // agent allows memory + notes + himalaya; policy permits memory +
    // hue only. Intersection = memory only.
    const out = registry.activeForAgent(
      'dm',
      ['memory', 'notes', 'himalaya'],
      ['memory', 'hue'],
    );
    expect(out.map((s) => s.name)).toEqual(['memory']);
  });

  it('drops disabled skills regardless of filters', () => {
    registry.setEnabled('memory', false);
    const out = registry.activeForAgent('dm', ['*'], ['*']);
    expect(out.map((s) => s.name)).not.toContain('memory');
  });

  it('honors session scope (dm-only skill is hidden from group sessions)', () => {
    // Re-register `notes` as DM-only.
    registry.register(makeSkill('notes', { scope: ['dm'] }));
    const dmOut = registry.activeForAgent('dm', ['*'], ['*']);
    const groupOut = registry.activeForAgent('group', ['*'], ['*']);
    expect(dmOut.map((s) => s.name)).toContain('notes');
    expect(groupOut.map((s) => s.name)).not.toContain('notes');
  });

  it('returns empty when agent.skills lists a skill that does not exist', () => {
    const out = registry.activeForAgent('dm', ['ghost'], ['*']);
    expect(out).toEqual([]);
  });

  it('returns empty when policy.skillsVisible lists a skill that does not exist', () => {
    const out = registry.activeForAgent('dm', ['*'], ['ghost']);
    expect(out).toEqual([]);
  });
});
