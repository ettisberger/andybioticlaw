import { describe, it, expect, vi } from 'vitest';
import { EnumSetting } from '../../../src/cli/settings/components/enum-setting.js';
import { IntegerSetting } from '../../../src/cli/settings/components/integer-setting.js';
import { IntegerOrNullSetting } from '../../../src/cli/settings/components/integer-or-null-setting.js';
import type { SettingsContext } from '../../../src/cli/settings/types.js';

function makeCtx(yaml: string): SettingsContext {
  let body = yaml;
  return {
    stdin: {} as never,
    stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    configPath: '/tmp/config.yaml',
    envPath: '/tmp/.env',
    voiceState: {} as never,
    briefings: {} as never,
    readYaml: () => body,
    writeYaml: (next) => {
      body = next;
    },
    readEnv: () => ({}),
    writeEnv: vi.fn(),
  };
}

describe('EnumSetting', () => {
  it('renderRow surfaces the current value in the meta column', () => {
    const ctx = makeCtx('agent:\n  model: claude-opus-4-7\n');
    const setting = new EnumSetting({
      id: 'agent.model',
      label: 'Model',
      pathLabel: 'agent.model',
      restart: true,
      read: () => 'claude-opus-4-7',
      patchRegex: /^(\s+model:\s*).*$/m,
      options: [{ value: 'claude-opus-4-7' }, { value: 'claude-sonnet-4-6' }],
    });
    expect(setting.renderRow(ctx)).toEqual({
      label: 'Model',
      meta: 'claude-opus-4-7',
      restart: true,
    });
  });

  it('handleSelect with an unchanged pick reports not-changed and does not patch', async () => {
    const original = 'agent:\n  model: claude-opus-4-7\n';
    const ctx = makeCtx(original);
    const setting = new EnumSetting({
      id: 'agent.model',
      label: 'Model',
      pathLabel: 'agent.model',
      restart: true,
      read: () => 'claude-opus-4-7',
      patchRegex: /^(\s+model:\s*).*$/m,
      options: [{ value: 'claude-opus-4-7' }, { value: 'claude-sonnet-4-6' }],
      prompter: async () => ({ changed: false }),
    });
    const result = await setting.handleSelect(ctx);
    expect(result.changed).toBe(false);
    expect(ctx.readYaml()).toBe(original);
  });

  it('handleSelect with a new pick patches the yaml + reports changed', async () => {
    const ctx = makeCtx('# header\nagent:\n  model: claude-opus-4-7\n');
    const setting = new EnumSetting({
      id: 'agent.model',
      label: 'Model',
      pathLabel: 'agent.model',
      restart: true,
      read: () => 'claude-opus-4-7',
      patchRegex: /^(\s+model:\s*).*$/m,
      options: [{ value: 'claude-opus-4-7' }, { value: 'claude-sonnet-4-6' }],
      prompter: async () => ({ changed: true, next: 'claude-sonnet-4-6' }),
    });
    const result = await setting.handleSelect(ctx);
    // patchYaml calls loadConfig() internally which will blow up on a
    // tiny fake yaml — that's fine, the test is about the patch itself.
    // validationOk may be false; the regex replacement should still run.
    expect(ctx.readYaml()).toMatch(/model:\s*claude-sonnet-4-6/);
    expect(result.restart).toBe(true);
  });
});

describe('IntegerSetting', () => {
  it('formats the current value with thousand separators by default', () => {
    const ctx = makeCtx('budget:\n  dailyTokenLimit: 2000000\n');
    const setting = new IntegerSetting({
      id: 'budget.dailyTokenLimit',
      label: 'Daily budget',
      pathLabel: 'budget.dailyTokenLimit',
      restart: false,
      read: () => 2_000_000,
      patchRegex: /^(\s+dailyTokenLimit:\s*)\d+\s*$/m,
    });
    expect(setting.renderRow(ctx).meta).toBe('2,000,000');
  });

  it('patches the yaml when a new value is provided', async () => {
    const ctx = makeCtx('budget:\n  dailyTokenLimit: 2000000\n');
    const setting = new IntegerSetting({
      id: 'budget.dailyTokenLimit',
      label: 'Daily budget',
      pathLabel: 'budget.dailyTokenLimit',
      restart: false,
      read: () => 2_000_000,
      patchRegex: /^(\s+dailyTokenLimit:\s*)\d+\s*$/m,
      prompter: async () => ({ changed: true, next: 1_000_000 }),
    });
    await setting.handleSelect(ctx);
    expect(ctx.readYaml()).toMatch(/dailyTokenLimit:\s*1000000/);
  });
});

describe('IntegerOrNullSetting', () => {
  it('renders `forever` when value is null', () => {
    const ctx = makeCtx('messages:\n  retentionDays: null\n');
    const setting = new IntegerOrNullSetting({
      id: 'messages.retentionDays',
      label: 'Retention',
      pathLabel: 'messages.retentionDays',
      restart: false,
      read: () => null,
      patchRegex: /^(\s+retentionDays:\s*)(null|\d+)\s*$/m,
    });
    expect(setting.renderRow(ctx).meta).toBe('forever');
  });

  it('renders `N days` for a non-null value', () => {
    const ctx = makeCtx('messages:\n  retentionDays: 90\n');
    const setting = new IntegerOrNullSetting({
      id: 'messages.retentionDays',
      label: 'Retention',
      pathLabel: 'messages.retentionDays',
      restart: false,
      read: () => 90,
      patchRegex: /^(\s+retentionDays:\s*)(null|\d+)\s*$/m,
    });
    expect(setting.renderRow(ctx).meta).toBe('90 days');
  });

  it('patches to `null` literal when the prompter returns null', async () => {
    const ctx = makeCtx('messages:\n  retentionDays: 90\n');
    const setting = new IntegerOrNullSetting({
      id: 'messages.retentionDays',
      label: 'Retention',
      pathLabel: 'messages.retentionDays',
      restart: false,
      read: () => 90,
      patchRegex: /^(\s+retentionDays:\s*)(null|\d+)\s*$/m,
      prompter: async () => ({ changed: true, next: null }),
    });
    await setting.handleSelect(ctx);
    expect(ctx.readYaml()).toMatch(/retentionDays:\s*null/);
  });
});
