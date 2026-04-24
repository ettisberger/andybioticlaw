import { describe, it, expect, vi } from 'vitest';
import { BooleanSetting } from '../../../src/cli/settings/components/boolean-setting.js';
import type { SettingsContext } from '../../../src/cli/settings/types.js';

function makeCtx(overrides: Partial<SettingsContext> = {}): SettingsContext {
  const stdout = {
    write: vi.fn(),
  } as unknown as NodeJS.WritableStream;
  return {
    stdin: {} as never,
    stdout,
    configPath: '/tmp/config.yaml',
    envPath: '/tmp/.env',
    voiceState: {} as never,
    briefings: {} as never,
    readYaml: () => '',
    writeYaml: vi.fn(),
    readEnv: () => ({}),
    writeEnv: vi.fn(),
    ...overrides,
  };
}

describe('BooleanSetting', () => {
  it('renderRow reflects the current read()', () => {
    const ctx = makeCtx();
    const trueSetting = new BooleanSetting({
      id: 'x',
      label: 'Thing',
      restart: false,
      read: () => true,
      write: () => {},
    });
    const falseSetting = new BooleanSetting({
      id: 'y',
      label: 'Thing',
      restart: true,
      read: () => false,
      write: () => {},
    });
    expect(trueSetting.renderRow(ctx)).toEqual({
      label: 'Thing',
      checked: true,
      restart: false,
    });
    expect(falseSetting.renderRow(ctx)).toEqual({
      label: 'Thing',
      checked: false,
      restart: true,
    });
  });

  it('handleSelect flips the stored value and reports changed + restart', async () => {
    let stored = false;
    const ctx = makeCtx();
    const setting = new BooleanSetting({
      id: 'x',
      label: 'Thing',
      restart: true,
      read: () => stored,
      write: (_ctx, next) => {
        stored = next;
      },
    });
    const first = await setting.handleSelect(ctx);
    expect(stored).toBe(true);
    expect(first).toEqual({ changed: true, restart: true });

    const second = await setting.handleSelect(ctx);
    expect(stored).toBe(false);
    expect(second).toEqual({ changed: true, restart: true });
  });

  it('respects canToggle guard: does not write, prints reason, reports unchanged', async () => {
    const writeSpy = vi.fn();
    const ctx = makeCtx();
    const setting = new BooleanSetting({
      id: 'x',
      label: 'Voice input',
      restart: false,
      read: () => false,
      write: writeSpy,
      canToggle: (_ctx, current) =>
        current ? null : 'set the Groq API key first, then enable.',
    });
    const result = await setting.handleSelect(ctx);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: false, restart: false });
    // The reason string should have been written to stdout.
    expect(ctx.stdout.write).toHaveBeenCalled();
    const written = (ctx.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(written).toMatch(/Groq API key first/);
  });

  it('async write is awaited before returning', async () => {
    let committed = false;
    const ctx = makeCtx();
    const setting = new BooleanSetting({
      id: 'x',
      label: 'Thing',
      restart: false,
      read: () => false,
      write: async () => {
        await new Promise((r) => setTimeout(r, 10));
        committed = true;
      },
    });
    await setting.handleSelect(ctx);
    expect(committed).toBe(true);
  });
});
