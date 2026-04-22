import { describe, it, expect } from 'vitest';
import { buildMcpConfig } from '../../src/skills/mcp.js';
import type { SkillRecord } from '../../src/skills/registry.js';

function skill(
  name: string,
  overrides: Partial<SkillRecord> = {},
): SkillRecord {
  return {
    name,
    version: '0.1.0',
    description: 'test',
    enabled: true,
    scope: ['dm'],
    requiredSecrets: [],
    aptDependencies: [],
    systemCommands: [],
    mcpServers: [],
    manifestPath: `/tmp/${name}/manifest.yaml`,
    skillMdPath: `/tmp/${name}/SKILL.md`,
    skillDir: `/tmp/${name}`,
    ...overrides,
  };
}

describe('buildMcpConfig', () => {
  const noSecrets = () => undefined;

  it('emits empty mcpServers when no skills or memory server', () => {
    const { config, warnings } = buildMcpConfig({
      skills: [],
      getSkillSecret: noSecrets,
    });
    expect(config.mcpServers).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('includes memory-proposal server when provided', () => {
    const { config } = buildMcpConfig({
      skills: [],
      memoryProposalServer: {
        command: '/usr/bin/node',
        args: ['/abs/path.js'],
        env: { FOO: 'bar' },
      },
      getSkillSecret: noSecrets,
    });
    expect(config.mcpServers['andybioticlaw-memory']).toEqual({
      command: '/usr/bin/node',
      args: ['/abs/path.js'],
      env: { FOO: 'bar' },
    });
  });

  it('interpolates declared secrets in skill server env', () => {
    const s = skill('calendar', {
      requiredSecrets: ['GOOGLE_TOKEN'],
      mcpServers: [
        {
          name: 'google-calendar',
          command: 'node',
          args: ['./s.js'],
          env: { AUTH: '${GOOGLE_TOKEN}' },
        },
      ],
    });
    const { config, warnings } = buildMcpConfig({
      skills: [s],
      getSkillSecret: (_name, secret) => (secret === 'GOOGLE_TOKEN' ? 'tok' : undefined),
    });
    expect(config.mcpServers['google-calendar']!.env['AUTH']).toBe('tok');
    expect(warnings).toEqual([]);
  });

  it('warns (and emits empty) when referencing a secret not in required_secrets', () => {
    const s = skill('a', {
      requiredSecrets: [],
      mcpServers: [
        {
          name: 'srv',
          command: 'node',
          args: [],
          env: { AUTH: '${SECRET_NOT_DECLARED}' },
        },
      ],
    });
    const { config, warnings } = buildMcpConfig({
      skills: [s],
      getSkillSecret: () => 'value',
    });
    expect(config.mcpServers['srv']!.env['AUTH']).toBe('');
    expect(warnings.some((w) => /not in required_secrets/.test(w))).toBe(true);
  });

  it('warns on name collision and drops the duplicate', () => {
    const s1 = skill('a', {
      mcpServers: [{ name: 'dup', command: 'node', args: [], env: {} }],
    });
    const s2 = skill('b', {
      mcpServers: [{ name: 'dup', command: 'node', args: [], env: {} }],
    });
    const { config, warnings } = buildMcpConfig({
      skills: [s1, s2],
      getSkillSecret: () => undefined,
    });
    expect(Object.keys(config.mcpServers)).toEqual(['dup']);
    expect(warnings.some((w) => /collision/.test(w))).toBe(true);
  });
});
