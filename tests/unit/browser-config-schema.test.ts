import { describe, it, expect } from 'vitest';
import {
  BrowserConfig,
  isHotReloadable,
  isRestartRequired,
} from '../../src/config/schema.js';

describe('BrowserConfig schema', () => {
  it('parses with all defaults', () => {
    const out = BrowserConfig.parse({});
    expect(out.enabled).toBe(false);
    expect(out.hostnameAllowlist).toEqual([]);
    expect(out.profiles).toEqual([]);
    expect(out.dashboard.enabled).toBe(true);
    expect(out.dashboard.retentionDays).toBe(7);
    expect(out.dashboard.retentionMb).toBe(50);
    expect(out.dashboard.screenshotOnSnapshot).toBe(false);
  });

  it('accepts a populated config', () => {
    const out = BrowserConfig.parse({
      enabled: true,
      hostnameAllowlist: ['proton.me', '*.proton.me'],
      profiles: [{ name: 'gmail', description: 'ProtonMail' }],
      defaultProfile: 'gmail',
    });
    expect(out.enabled).toBe(true);
    expect(out.profiles).toHaveLength(1);
    expect(out.profiles[0]!.name).toBe('gmail');
    expect(out.defaultProfile).toBe('gmail');
  });

  it('rejects an invalid profile name', () => {
    const r = BrowserConfig.safeParse({
      profiles: [{ name: 'BadName' }], // uppercase rejected
    });
    expect(r.success).toBe(false);
  });

  it('rejects profile name starting with a digit', () => {
    const r = BrowserConfig.safeParse({
      profiles: [{ name: '1bad' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects out-of-range retention', () => {
    expect(
      BrowserConfig.safeParse({ dashboard: { retentionDays: 0 } }).success,
    ).toBe(false);
    expect(
      BrowserConfig.safeParse({ dashboard: { retentionMb: 5 } }).success,
    ).toBe(false);
  });
});

describe('reload classification for browser.* paths', () => {
  it('classifies hot-reloadable paths', () => {
    expect(isHotReloadable('browser.hostnameAllowlist')).toBe(true);
    expect(isHotReloadable('browser.dashboard.enabled')).toBe(true);
    expect(isHotReloadable('browser.dashboard.retentionDays')).toBe(true);
    expect(isHotReloadable('browser.dashboard.retentionMb')).toBe(true);
    expect(isHotReloadable('browser.dashboard.screenshotOnSnapshot')).toBe(true);
  });

  it('classifies restart-required paths', () => {
    expect(isRestartRequired('browser.enabled')).toBe(true);
    expect(isRestartRequired('browser.profiles')).toBe(true);
    expect(isRestartRequired('browser.defaultProfile')).toBe(true);
  });

  it('the two sets do not overlap', () => {
    const paths = [
      'browser.enabled',
      'browser.hostnameAllowlist',
      'browser.profiles',
      'browser.defaultProfile',
      'browser.dashboard.enabled',
      'browser.dashboard.retentionDays',
      'browser.dashboard.retentionMb',
      'browser.dashboard.screenshotOnSnapshot',
    ];
    for (const p of paths) {
      // Each path is in exactly one of the two sets.
      const hot = isHotReloadable(p);
      const restart = isRestartRequired(p);
      expect(hot !== restart).toBe(true);
    }
  });
});
