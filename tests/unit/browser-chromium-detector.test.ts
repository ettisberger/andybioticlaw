import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findChromiumBinary } from '../../src/browser/chromium-detector.js';

describe('findChromiumBinary', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-chromium-det-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeChromeAt(rel: string): string {
    const full = resolve(dir, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, '#!/bin/sh\nexit 0\n');
    return full;
  }

  it('detects the modern x86_64 layout (chrome-linux64)', () => {
    const path = writeChromeAt('chromium-1223/chrome-linux64/chrome');
    expect(findChromiumBinary(dir)).toBe(path);
  });

  it('detects the legacy x86_64 layout (chrome-linux)', () => {
    const path = writeChromeAt('chromium-1140/chrome-linux/chrome');
    expect(findChromiumBinary(dir)).toBe(path);
  });

  it('detects the ARM layout (chrome-linux-arm64)', () => {
    const path = writeChromeAt('chromium-1300/chrome-linux-arm64/chrome');
    expect(findChromiumBinary(dir)).toBe(path);
  });

  it('returns null when chromium-* exists but the binary is absent', () => {
    mkdirSync(resolve(dir, 'chromium-1223', 'chrome-linux64'), { recursive: true });
    expect(findChromiumBinary(dir)).toBeNull();
  });

  it('returns null when the browsersDir is empty', () => {
    expect(findChromiumBinary(dir)).toBeNull();
  });

  it('returns null when the browsersDir does not exist', () => {
    expect(findChromiumBinary(resolve(dir, 'nope'))).toBeNull();
  });

  it('ignores non-chromium subdirs (firefox, webkit) and non-chrome platform dirs', () => {
    // Distractor subdirs that should not match.
    mkdirSync(resolve(dir, 'firefox-1450'), { recursive: true });
    mkdirSync(resolve(dir, 'chromium-1223', 'something-else'), { recursive: true });
    expect(findChromiumBinary(dir)).toBeNull();

    // Real one shows up now → detected.
    const real = writeChromeAt('chromium-1223/chrome-linux64/chrome');
    expect(findChromiumBinary(dir)).toBe(real);
  });

  it('picks the first chromium-* it walks (deterministic per readdir order)', () => {
    // Two valid chromium builds side-by-side — function returns the
    // first match readdir hands us. We don't promise a specific
    // version, just that we find ONE chrome.
    writeChromeAt('chromium-1140/chrome-linux/chrome');
    writeChromeAt('chromium-1223/chrome-linux64/chrome');
    const out = findChromiumBinary(dir);
    expect(out).not.toBeNull();
    expect(out!.endsWith('/chrome')).toBe(true);
  });
});
