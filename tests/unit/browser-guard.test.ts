import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  checkAllowed,
  matchesPattern,
} from '../../skills/browser/mcp-server/src/guard.js';

describe('canonicalize', () => {
  it('lowercases plain ASCII hostnames', () => {
    expect(canonicalize('PROTON.ME')).toBe('proton.me');
  });

  it('strips trailing dot', () => {
    expect(canonicalize('proton.me.')).toBe('proton.me');
  });

  it('punycodes IDN hostnames', () => {
    expect(canonicalize('münich.example')).toBe('xn--mnich-kva.example');
  });

  it('returns empty string for empty input', () => {
    expect(canonicalize('')).toBe('');
  });
});

describe('matchesPattern', () => {
  it('matches exact host', () => {
    expect(matchesPattern('proton.me', 'proton.me')).toBe(true);
    expect(matchesPattern('mail.proton.me', 'proton.me')).toBe(false);
  });

  it('wildcard requires at least one subdomain label', () => {
    expect(matchesPattern('mail.proton.me', '*.proton.me')).toBe(true);
    expect(matchesPattern('a.b.proton.me', '*.proton.me')).toBe(true);
    // Bare apex does NOT match the wildcard form.
    expect(matchesPattern('proton.me', '*.proton.me')).toBe(false);
  });

  it('bare-wildcard "*" matches anything', () => {
    expect(matchesPattern('anything.example', '*')).toBe(true);
    expect(matchesPattern('proton.me', '*')).toBe(true);
  });

  it('canonicalizes both sides — IDN homoglyph cannot bypass ASCII pattern', () => {
    // 'protоn.me' with a Cyrillic-o (U+043E) — punycodes to xn--proton-9ie.me
    const homoglyph = 'protоn.me';
    expect(matchesPattern(homoglyph, 'proton.me')).toBe(false);
  });

  it('handles operator-side IDN — punycodes the pattern too', () => {
    expect(matchesPattern('münich.example', 'münich.example')).toBe(true);
    // Pre-punycoded equivalent must also match.
    expect(matchesPattern('münich.example', 'xn--mnich-kva.example')).toBe(true);
  });

  it('case-insensitive on both inputs', () => {
    expect(matchesPattern('MAIL.PROTON.ME', '*.PROTON.ME')).toBe(true);
  });
});

describe('checkAllowed', () => {
  const allowlist = ['proton.me', '*.proton.me', 'news.ycombinator.com'];

  it('returns null for allowed host', () => {
    expect(checkAllowed('https://news.ycombinator.com/news', allowlist)).toBeNull();
    expect(checkAllowed('https://mail.proton.me/u/0/inbox', allowlist)).toBeNull();
    expect(checkAllowed('https://proton.me', allowlist)).toBeNull();
  });

  it('rejects disallowed host with a helpful reason', () => {
    const reason = checkAllowed('https://twitter.com/foo', allowlist);
    expect(reason).toContain('twitter.com');
    expect(reason).toContain('hostnameAllowlist');
  });

  it('rejects when allowlist is empty', () => {
    const reason = checkAllowed('https://proton.me', []);
    expect(reason).toContain('no hostname allowlist');
  });

  it('rejects invalid URL', () => {
    const reason = checkAllowed('not a url', allowlist);
    expect(reason).toMatch(/invalid URL|not on browser/);
  });

  it('accepts bare hostname (no URL scheme)', () => {
    expect(checkAllowed('proton.me', allowlist)).toBeNull();
    expect(checkAllowed('twitter.com', allowlist)).toContain('twitter.com');
  });

  it('IDN homoglyph cannot bypass allowlist', () => {
    // Cyrillic-о in 'protоn.me'
    const homoglyph = 'https://protоn.me/login';
    const reason = checkAllowed(homoglyph, ['proton.me']);
    expect(reason).not.toBeNull();
  });
});
