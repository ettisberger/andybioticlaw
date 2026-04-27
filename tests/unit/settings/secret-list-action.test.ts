import { describe, it, expect, vi } from 'vitest';
import { SecretSetting } from '../../../src/cli/settings/components/secret-setting.js';
import { ListSetting } from '../../../src/cli/settings/components/list-setting.js';
import { ActionSetting } from '../../../src/cli/settings/components/action-setting.js';
import type { SettingsContext } from '../../../src/cli/settings/types.js';

function makeCtx(initial: { yaml?: string; env?: Record<string, string> } = {}): SettingsContext & {
  envStore: Record<string, string>;
} {
  let yaml = initial.yaml ?? '';
  const envStore: Record<string, string> = { ...(initial.env ?? {}) };
  const base: SettingsContext = {
    stdin: {} as never,
    stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    configPath: '/tmp/config.yaml',
    envPath: '/tmp/.env',
    voiceState: {} as never,
    readYaml: () => yaml,
    writeYaml: (next: string) => {
      yaml = next;
    },
    readEnv: () => ({ ...envStore }),
    writeEnv: (updates: Record<string, string>) => {
      for (const [k, v] of Object.entries(updates)) {
        envStore[k] = v;
      }
    },
  };
  return Object.assign(base, { envStore });
}

describe('SecretSetting (env storage)', () => {
  it("renders 'not set' when the env value is empty", () => {
    const ctx = makeCtx({ env: {} });
    const setting = new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
    });
    expect(setting.renderRow(ctx).meta).toBe('not set');
  });

  it('renders a masked preview when the env value is set', () => {
    const ctx = makeCtx({ env: { GROQ_API_KEY: 'gsk_abcdefghijklmnopY8k3' } });
    const setting = new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
    });
    expect(setting.renderRow(ctx).meta).toMatch(/^gsk_ab/);
    expect(setting.renderRow(ctx).meta).toMatch(/Y8k3$/);
    expect(setting.renderRow(ctx).meta).toContain('••');
  });

  it('Set path writes the transformed value to env', async () => {
    const ctx = makeCtx({ env: {} });
    // Stub picker → choose "Set" (idx 0), stub prompter → return a new key.
    const pickerStub = vi.fn(async () => 0) as never;
    const secretStub = vi.fn(async () => ({ changed: true, next: 'gsk_new' })) as never;
    const setting = new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
      picker: pickerStub,
      secretPrompt: secretStub,
    });
    const result = await setting.handleSelect(ctx);
    expect(ctx.envStore.GROQ_API_KEY).toBe('gsk_new');
    expect(result).toEqual({ changed: true, restart: true });
  });

  it('Remove path clears the env value and runs onRemove callback', async () => {
    const ctx = makeCtx({ env: { GROQ_API_KEY: 'gsk_existing' } });
    const pickerStub = vi.fn(async () => 1) as never; // index 1 = Remove when hasKey
    const onRemove = vi.fn();
    const setting = new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
      picker: pickerStub,
      onRemove,
    });
    const result = await setting.handleSelect(ctx);
    expect(ctx.envStore.GROQ_API_KEY).toBe('');
    expect(onRemove).toHaveBeenCalledOnce();
    expect(result.changed).toBe(true);
  });

  it('Cancel path leaves state untouched', async () => {
    const ctx = makeCtx({ env: { GROQ_API_KEY: 'gsk_existing' } });
    // 3 items when hasKey: Update(0) / Remove(1) / Cancel(2)
    const pickerStub = vi.fn(async () => 2) as never;
    const setting = new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
      picker: pickerStub,
    });
    const result = await setting.handleSelect(ctx);
    expect(ctx.envStore.GROQ_API_KEY).toBe('gsk_existing');
    expect(result).toEqual({ changed: false, restart: false });
  });

  it('applies the `transform` callback before persistence (e.g. argon2 hash)', async () => {
    const ctx = makeCtx({ env: {} });
    const transform = vi.fn(async (v: string) => `hashed:${v}`);
    const setting = new SecretSetting({
      id: 'dashboard.basicAuth.passwordHash',
      label: 'Dashboard password',
      restart: true,
      storage: { kind: 'env', key: 'DASHBOARD_HASH' },
      transform,
      picker: (async () => 0) as never,
      secretPrompt: (async () => ({ changed: true, next: 'hunter2' })) as never,
    });
    await setting.handleSelect(ctx);
    expect(transform).toHaveBeenCalledWith('hunter2');
    expect(ctx.envStore.DASHBOARD_HASH).toBe('hashed:hunter2');
  });
});

describe('ListSetting', () => {
  it('renders count + ids when non-empty', () => {
    const ctx = makeCtx();
    const setting = new ListSetting({
      id: 'telegram.allowedUserIds',
      label: 'Allowed users',
      pathLabel: 'telegram.dm.allowedUserIds',
      restart: true,
      read: () => [111, 222],
      patchRegex: /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
    });
    expect(setting.renderRow(ctx).meta).toBe('2: 111, 222');
  });

  it('renders custom emptyLabel when the list is empty', () => {
    const ctx = makeCtx();
    const setting = new ListSetting({
      id: 'telegram.allowedUserIds',
      label: 'Allowed users',
      pathLabel: 'telegram.dm.allowedUserIds',
      restart: true,
      read: () => [],
      patchRegex: /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
      emptyLabel: '(none — bot rejects all DMs)',
    });
    expect(setting.renderRow(ctx).meta).toBe('(none — bot rejects all DMs)');
  });

  it('patches the yaml when the prompter returns a new list', async () => {
    const ctx = makeCtx({
      yaml: '  dm:\n    allowedUserIds: [111]\n',
    });
    const setting = new ListSetting({
      id: 'telegram.allowedUserIds',
      label: 'Allowed users',
      pathLabel: 'telegram.dm.allowedUserIds',
      restart: true,
      read: () => [111],
      patchRegex: /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
      prompter: async () => ({ changed: true, next: [111, 222] }),
    });
    await setting.handleSelect(ctx);
    expect(ctx.readYaml()).toMatch(/allowedUserIds:\s*\[111, 222\]/);
  });
});

describe('ActionSetting', () => {
  it('renderRow returns the dynamic meta', () => {
    const ctx = makeCtx();
    const setting = new ActionSetting({
      id: 'voice.test',
      label: 'Test transcription',
      renderMeta: () => '(set key first)',
      action: async () => {},
    });
    expect(setting.renderRow(ctx)).toEqual({
      label: 'Test transcription',
      meta: '(set key first)',
      restart: false,
    });
  });

  it('handleSelect runs the action and returns {changed:false, restart:false}', async () => {
    const ctx = makeCtx();
    const action = vi.fn();
    const setting = new ActionSetting({
      id: 'voice.test',
      label: 'Test transcription',
      renderMeta: () => '',
      action,
    });
    const result = await setting.handleSelect(ctx);
    expect(action).toHaveBeenCalledOnce();
    expect(result).toEqual({ changed: false, restart: false });
  });
});
