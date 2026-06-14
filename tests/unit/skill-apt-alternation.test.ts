import { describe, it, expect } from 'vitest';
import { resolveAptAlternation } from '../../src/skills/apt-deps-helper.js';

describe('resolveAptAlternation', () => {
  it('returns a bare name unchanged', () => {
    expect(resolveAptAlternation('libnss3')).toBe('libnss3');
  });

  it('trims whitespace around a bare name', () => {
    expect(resolveAptAlternation('  libnss3  ')).toBe('libnss3');
  });

  it('returns the only entry for a single-element alternation', () => {
    expect(resolveAptAlternation('libnss3 | ')).toBe('libnss3');
  });

  it('picks the first installable for multi-element alternation', () => {
    // On a host without apt-cache, both probes fail → fallback to the
    // first listed alternative. Either way, the result is deterministic.
    const out = resolveAptAlternation('libasound2t64 | libasound2');
    expect(['libasound2t64', 'libasound2']).toContain(out);
  });

  it('falls back to the first entry when nothing is installable', () => {
    // These names won't resolve on any apt host. Helper picks the
    // first alternative as a stable fallback rather than guessing.
    const out = resolveAptAlternation('not-a-real-pkg-xyz | also-not-real-pkg');
    expect(out).toBe('not-a-real-pkg-xyz');
  });

  it('handles whitespace and empty entries gracefully', () => {
    const out = resolveAptAlternation(' libnss3 |  | ');
    expect(out).toBe('libnss3');
  });
});
