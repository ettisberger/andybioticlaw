import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/telegram/redact.js';

/**
 * Last-mile redaction is the load-bearing security control:
 * regardless of how Emma obtained a secret (env var, file read,
 * config dump), if she tries to type it into a Telegram reply we
 * replace the literal with `[REDACTED]` and write an audit row.
 *
 * These tests pin the behaviour we depend on.
 */

describe('redactSecrets', () => {
  it('returns text unchanged when no secrets are provided', () => {
    const result = redactSecrets('hello world', new Set());
    expect(result.redacted).toBe('hello world');
    expect(result.hits).toBe(0);
  });

  it('returns text unchanged when none of the secrets appear in it', () => {
    const secrets = new Set(['gsk_abcdef1234567890ABCDEF']);
    const result = redactSecrets('the meeting is at 3pm tomorrow', secrets);
    expect(result.redacted).toBe('the meeting is at 3pm tomorrow');
    expect(result.hits).toBe(0);
  });

  it('replaces a single occurrence of a known secret with [REDACTED]', () => {
    const secret = 'gsk_abcdef1234567890ABCDEF';
    const secrets = new Set([secret]);
    const input = `here is the key: ${secret}`;
    const result = redactSecrets(input, secrets);
    expect(result.redacted).toBe('here is the key: [REDACTED]');
    expect(result.hits).toBe(1);
  });

  it('replaces multiple occurrences of the same secret', () => {
    const secret = 'AAAAAAAAAAAA_a_long_token_1234';
    const secrets = new Set([secret]);
    const input = `first ${secret} and again ${secret} end`;
    const result = redactSecrets(input, secrets);
    expect(result.redacted).toBe('first [REDACTED] and again [REDACTED] end');
    expect(result.hits).toBe(2);
  });

  it('replaces multiple different secrets in the same message', () => {
    const a = 'gsk_aaaaaaaaaaaa_long_token';
    const b = 'hue_bbbbbbbbbbbb_other_token';
    const secrets = new Set([a, b]);
    const input = `A=${a} B=${b}`;
    const result = redactSecrets(input, secrets);
    expect(result.redacted).toBe('A=[REDACTED] B=[REDACTED]');
    expect(result.hits).toBe(2);
  });

  it('skips secrets shorter than 12 chars (false-positive guard)', () => {
    // 11-char value: common user text like "hello world" shouldn't
    // accidentally match against a short debug token.
    const secrets = new Set(['abc12345678']); // 11 chars
    const input = 'random content containing abc12345678 literally';
    const result = redactSecrets(input, secrets);
    // Short secret is skipped; the literal passes through.
    expect(result.redacted).toBe('random content containing abc12345678 literally');
    expect(result.hits).toBe(0);
  });

  it('handles secrets with regex-special characters correctly', () => {
    // Tokens can legitimately contain `.`, `+`, `/`, `=` (base64), `$`
    // (env-var-like), etc. The implementation must escape these so the
    // underlying String.replace regex matches the literal, not regex
    // metacharacters.
    const secret = 'abc+def/ghi=jkl.mno$pqr';
    const secrets = new Set([secret]);
    const input = `embedded: ${secret} here`;
    const result = redactSecrets(input, secrets);
    expect(result.redacted).toBe('embedded: [REDACTED] here');
    expect(result.hits).toBe(1);
  });

  it('does not redact empty string or undefined values in the set', () => {
    // A caller might accidentally include an unset env var value (empty
    // string). Redacting "" would match every position in the text.
    const secrets = new Set(['', 'another_very_long_value_token']);
    const result = redactSecrets('nothing to see', secrets);
    expect(result.redacted).toBe('nothing to see');
    expect(result.hits).toBe(0);
  });

  it('reports which secret values matched (for audit use)', () => {
    // The return shape includes `matchedValues` so the caller can write
    // one audit row per leaked secret (deduped), not one per flush.
    const a = 'secret_aaaaaaaa_long_enough';
    const b = 'secret_bbbbbbbb_long_enough';
    const secrets = new Set([a, b]);
    const result = redactSecrets(`${a} and nothing else`, secrets);
    expect(result.matchedValues.has(a)).toBe(true);
    expect(result.matchedValues.has(b)).toBe(false);
  });
});
