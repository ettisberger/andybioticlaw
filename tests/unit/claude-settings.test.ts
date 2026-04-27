import { describe, it, expect } from 'vitest';
import { buildClaudeSessionSettings } from '../../src/agent/claude-settings.js';
import type { ResolvedPolicy } from '../../src/policies/schema.js';

/**
 * The per-session .claude/settings.json file is the only thing standing
 * between Emma and arbitrary Bash on a tightened install. Three things
 * have to be right:
 *   1. defaultMode tracks execMode ('full' → bypass; else → 'default').
 *   2. Skill exec_allow + policy execAllow merge + dedupe correctly.
 *   3. The _meta block records who contributed which patterns so the
 *      operator can audit a session post-mortem.
 */

const fullPolicy: ResolvedPolicy = {
  scheduleKinds: ['reminder'],
  scheduleAgentTaskCap: 0,
  execMode: 'full',
  execAllow: [],
  skillsVisible: ['*'],
};

const allowlistPolicy: ResolvedPolicy = {
  scheduleKinds: ['reminder'],
  scheduleAgentTaskCap: 0,
  execMode: 'allowlist',
  execAllow: ['Bash(git status*)'],
  skillsVisible: ['*'],
};

const denyPolicy: ResolvedPolicy = {
  ...allowlistPolicy,
  execMode: 'deny',
  execAllow: [],
};

describe('buildClaudeSessionSettings', () => {
  it("execMode='full' → defaultMode='bypassPermissions' (today's behaviour)", () => {
    const s = buildClaudeSessionSettings({
      policy: fullPolicy,
      skills: [],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.defaultMode).toBe('bypassPermissions');
    expect(s.permissions.allow).toEqual([]);
  });

  it("execMode='allowlist' → defaultMode='default' + policy patterns surface", () => {
    const s = buildClaudeSessionSettings({
      policy: allowlistPolicy,
      skills: [],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.defaultMode).toBe('default');
    expect(s.permissions.allow).toEqual(['Bash(git status*)']);
  });

  it("execMode='deny' → defaultMode='default' + zero patterns when no skills", () => {
    const s = buildClaudeSessionSettings({
      policy: denyPolicy,
      skills: [],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.defaultMode).toBe('default');
    expect(s.permissions.allow).toEqual([]);
  });

  it('merges skill exec_allow patterns into allow list', () => {
    const s = buildClaudeSessionSettings({
      policy: allowlistPolicy,
      skills: [
        { name: 'himalaya', execAllow: ['Bash(himalaya *)'] },
        { name: 'notes', execAllow: [] },
      ],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.allow).toEqual([
      'Bash(git status*)',
      'Bash(himalaya *)',
    ]);
  });

  it('dedupes patterns that appear in BOTH policy and a skill manifest', () => {
    const s = buildClaudeSessionSettings({
      policy: { ...allowlistPolicy, execAllow: ['Bash(himalaya *)'] },
      skills: [{ name: 'himalaya', execAllow: ['Bash(himalaya *)'] }],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.allow).toEqual(['Bash(himalaya *)']);
  });

  it('records contributions in _meta so post-mortem audit works', () => {
    const s = buildClaudeSessionSettings({
      policy: { ...allowlistPolicy, execAllow: ['Bash(git status*)'] },
      skills: [{ name: 'himalaya', execAllow: ['Bash(himalaya *)'] }],
      contextKey: 'emma:telegram:18998064',
    });
    expect(s._meta.generatedBy).toBe('andybioticlaw');
    expect(s._meta.contextKey).toBe('emma:telegram:18998064');
    expect(s._meta.execMode).toBe('allowlist');
    expect(s._meta.policyContributions).toEqual(['Bash(git status*)']);
    expect(s._meta.skillContributions).toEqual([
      { skill: 'himalaya', pattern: 'Bash(himalaya *)' },
    ]);
  });

  it('deny array is always empty (reserved for a future denyExec axis)', () => {
    const s = buildClaudeSessionSettings({
      policy: allowlistPolicy,
      skills: [],
      contextKey: 'emma:telegram:1',
    });
    expect(s.permissions.deny).toEqual([]);
  });
});
