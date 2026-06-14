import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveSecrets,
  SecretMissingError,
} from '../../skills/browser/mcp-server/src/secret-templating.js';

describe('resolveSecrets', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    process.env.PROTON_PASSWORD = 'sekret!';
    process.env.GITHUB_TOKEN = 'ghp_xxxx';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('returns text unchanged when no placeholder', () => {
    expect(resolveSecrets('hello world')).toEqual({
      text: 'hello world',
      usedSecret: false,
    });
  });

  it('substitutes a single placeholder', () => {
    expect(resolveSecrets('login {{PROTON_PASSWORD}} now')).toEqual({
      text: 'login sekret! now',
      usedSecret: true,
    });
  });

  it('substitutes multiple placeholders and reports usedSecret once', () => {
    expect(resolveSecrets('{{PROTON_PASSWORD}}-{{GITHUB_TOKEN}}')).toEqual({
      text: 'sekret!-ghp_xxxx',
      usedSecret: true,
    });
  });

  it('throws on missing secret rather than silently dropping', () => {
    expect(() => resolveSecrets('use {{MISSING_TOKEN}} please')).toThrow(
      SecretMissingError,
    );
  });

  it('ignores non-uppercase placeholders (not the secret shape)', () => {
    // {{lower}} doesn't match SCREAMING_SNAKE_CASE pattern.
    expect(resolveSecrets('value={{lower}}')).toEqual({
      text: 'value={{lower}}',
      usedSecret: false,
    });
  });

  it('handles empty input', () => {
    expect(resolveSecrets('')).toEqual({ text: '', usedSecret: false });
    expect(resolveSecrets(undefined as unknown as string)).toEqual({
      text: '',
      usedSecret: false,
    });
  });
});
