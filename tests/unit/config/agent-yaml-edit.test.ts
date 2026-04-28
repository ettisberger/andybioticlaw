import { describe, it, expect } from 'vitest';
import {
  applyAgentPatch,
  AgentPatchError,
} from '../../../src/config/agent-yaml-edit.js';

/**
 * The patch helper is the only thing standing between a dashboard
 * "save" button and a corrupt config.yaml. Every test here either
 * proves we touched the right line OR proves we didn't touch
 * anything we shouldn't have.
 */

const ONE_AGENT_YAML = `service:
  name: andybioticlaw
  logLevel: info

agents:
  - id: emma
    name: Emma
    default: true
    model: claude-opus-4-7
    haikuModel: claude-haiku-4-5-20251001
    skills: ['*']
    routing:
      enabled: false
      minCharsForOpus: 120

bindings: []
`;

const TWO_AGENT_YAML = `agents:
  - id: emma
    name: Emma
    default: true
    model: claude-opus-4-7
    haikuModel: claude-haiku-4-5-20251001
    skills: ['*']
    routing:
      enabled: false
      minCharsForOpus: 120
  - id: work
    name: Work
    default: false
    model: claude-sonnet-4-6
    haikuModel: claude-haiku-4-5-20251001
    skills: [notes]
    routing:
      enabled: true
      minCharsForOpus: 80

bindings: []
`;

describe('applyAgentPatch — single agent', () => {
  it('updates model, leaving every other byte untouched', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      model: 'claude-sonnet-4-6',
    });
    expect(next).toContain('model: claude-sonnet-4-6');
    expect(next).not.toContain('model: claude-opus-4-7');
    // Sanity: the rest of the file is byte-identical.
    expect(next.replace('model: claude-sonnet-4-6', 'model: claude-opus-4-7')).toBe(
      ONE_AGENT_YAML,
    );
  });

  it('updates haikuModel without touching model', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      haikuModel: 'claude-sonnet-4-6',
    });
    expect(next).toContain('model: claude-opus-4-7');
    expect(next).toContain('haikuModel: claude-sonnet-4-6');
  });

  it('flips routing.enabled', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      routing: { enabled: true },
    });
    expect(next).toContain('enabled: true');
    expect(next).toContain('minCharsForOpus: 120');
  });

  it('updates minCharsForOpus', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      routing: { minCharsForOpus: 200 },
    });
    expect(next).toContain('minCharsForOpus: 200');
    expect(next).toContain('enabled: false');
  });

  it('combines multiple fields in one call', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      model: 'claude-opus-4-6',
      routing: { enabled: true, minCharsForOpus: 250 },
    });
    expect(next).toContain('model: claude-opus-4-6');
    expect(next).toContain('enabled: true');
    expect(next).toContain('minCharsForOpus: 250');
  });

  it('writes skills as the canonical wildcard', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', { skills: '*' });
    expect(next).toContain(`skills: ['*']`);
  });

  it('writes skills as an explicit list', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', {
      skills: ['notes', 'google-calendar'],
    });
    expect(next).toContain(`skills: ['notes', 'google-calendar']`);
  });

  it('writes empty skills as []', () => {
    const next = applyAgentPatch(ONE_AGENT_YAML, 'emma', { skills: [] });
    expect(next).toContain('skills: []');
  });

  it('rejects a skill name with bad characters', () => {
    expect(() =>
      applyAgentPatch(ONE_AGENT_YAML, 'emma', {
        skills: ['notes', "'; rm -rf /"],
      }),
    ).toThrow(AgentPatchError);
  });

  it('rejects a non-integer minCharsForOpus', () => {
    expect(() =>
      applyAgentPatch(ONE_AGENT_YAML, 'emma', {
        routing: { minCharsForOpus: 1.5 },
      }),
    ).toThrow(/integer/);
  });

  it('rejects a negative minCharsForOpus', () => {
    expect(() =>
      applyAgentPatch(ONE_AGENT_YAML, 'emma', {
        routing: { minCharsForOpus: -1 },
      }),
    ).toThrow(/non-negative/);
  });

  it('throws when the agent id is unknown', () => {
    expect(() =>
      applyAgentPatch(ONE_AGENT_YAML, 'ghost', { model: 'x' }),
    ).toThrow(/no agent with id "ghost"/);
  });

  it('preserves trailing whitespace and a top-level comment', () => {
    const yaml = `# top comment\n${ONE_AGENT_YAML}\n# trailing\n`;
    const next = applyAgentPatch(yaml, 'emma', { model: 'claude-sonnet-4-6' });
    expect(next.startsWith('# top comment\n')).toBe(true);
    expect(next.endsWith('# trailing\n')).toBe(true);
  });
});

describe('applyAgentPatch — multi-agent isolation', () => {
  it('edits emma without touching work', () => {
    const next = applyAgentPatch(TWO_AGENT_YAML, 'emma', {
      model: 'claude-opus-4-6',
    });
    // emma's model flipped:
    expect(next).toMatch(/id: emma[\s\S]+?model: claude-opus-4-6/);
    // work's model unchanged:
    expect(next).toMatch(/id: work[\s\S]+?model: claude-sonnet-4-6/);
  });

  it('edits work without touching emma', () => {
    const next = applyAgentPatch(TWO_AGENT_YAML, 'work', {
      routing: { minCharsForOpus: 50 },
    });
    expect(next).toMatch(/id: work[\s\S]+?minCharsForOpus: 50/);
    expect(next).toMatch(/id: emma[\s\S]+?minCharsForOpus: 120/);
  });

  it('flips work.routing.enabled without touching emma.routing.enabled', () => {
    const next = applyAgentPatch(TWO_AGENT_YAML, 'work', {
      routing: { enabled: false },
    });
    expect(next).toMatch(/id: emma[\s\S]+?enabled: false/);
    expect(next).toMatch(/id: work[\s\S]+?enabled: false/);
    // Work was true; now both are false. Verify the bytes between
    // the two agents (emma's block) are still intact.
    const emmaBlock = next.match(/- id: emma[\s\S]+?(?=^  - id:)/m);
    expect(emmaBlock).toBeTruthy();
    expect(emmaBlock![0]).toContain('enabled: false');
    expect(emmaBlock![0]).toContain('minCharsForOpus: 120');
  });

  it('throws if you patch a field the agent block does not have', () => {
    const yamlMissingHaiku = `agents:
  - id: minimal
    name: Min
    default: true
    model: claude-opus-4-7
    skills: ['*']
`;
    expect(() =>
      applyAgentPatch(yamlMissingHaiku, 'minimal', {
        haikuModel: 'claude-haiku-4-5-20251001',
      }),
    ).toThrow(/has no `haikuModel:` line/);
  });
});

describe('applyAgentPatch — comment preservation', () => {
  it('does not touch a comment inside the agent block', () => {
    const yaml = `agents:
  - id: emma
    name: Emma
    default: true
    # IMPORTANT: don't downgrade model below 4-7 without re-testing memory recall
    model: claude-opus-4-7
    haikuModel: claude-haiku-4-5-20251001
    skills: ['*']
    routing:
      # routing disabled — Emma's principal answers Opus-quality every time
      enabled: false
      minCharsForOpus: 120
`;
    const next = applyAgentPatch(yaml, 'emma', { model: 'claude-opus-4-6' });
    expect(next).toContain(
      "# IMPORTANT: don't downgrade model below 4-7 without re-testing memory recall",
    );
    expect(next).toContain(
      "# routing disabled — Emma's principal answers Opus-quality every time",
    );
    expect(next).toContain('model: claude-opus-4-6');
  });
});
