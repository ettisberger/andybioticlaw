import { describe, it, expect, afterEach } from 'vitest';
import {
  API_BILLING_ENV_VARS,
  API_KEY_SOURCE_REJECT,
} from '../../src/agent/credentials.js';
import { buildClaudeEnv } from '../../src/agent/runner.js';

describe('API-billing env var filtering', () => {
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [k, v] of saved.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  function setEnv(k: string, v: string) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    process.env[k] = v;
  }

  it('API_BILLING_ENV_VARS covers the known billing-switch vars', () => {
    // Defensive regression: if this list ever shrinks, catch it in review.
    expect(API_BILLING_ENV_VARS).toContain('ANTHROPIC_API_KEY');
    expect(API_BILLING_ENV_VARS).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(API_BILLING_ENV_VARS).toContain('ANTHROPIC_BASE_URL');
    expect(API_BILLING_ENV_VARS).toContain('CLAUDE_CODE_USE_BEDROCK');
    expect(API_BILLING_ENV_VARS).toContain('CLAUDE_CODE_USE_VERTEX');
  });

  it('buildClaudeEnv strips every billing env var', () => {
    for (const v of API_BILLING_ENV_VARS) setEnv(v, 'should-be-stripped');
    const out = buildClaudeEnv();
    for (const v of API_BILLING_ENV_VARS) {
      expect(out[v]).toBeUndefined();
    }
  });

  it('buildClaudeEnv preserves unrelated env vars', () => {
    setEnv('UNRELATED_VAR_FOR_TEST', 'keep-me');
    setEnv('ANTHROPIC_API_KEY', 'strip-me');
    const out = buildClaudeEnv();
    expect(out['UNRELATED_VAR_FOR_TEST']).toBe('keep-me');
    expect(out['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('buildClaudeEnv accepts a custom base (isolation)', () => {
    const out = buildClaudeEnv({
      PATH: '/custom/path',
      ANTHROPIC_API_KEY: 'nope',
      ANTHROPIC_BASE_URL: 'https://nope',
      FOO: 'bar',
    });
    expect(out['PATH']).toBe('/custom/path');
    expect(out['FOO']).toBe('bar');
    expect(out['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(out['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  // Regression: CLAUDE_CODE_OAUTH_TOKEN is subscription-bound (same billing
  // path as a keyring session), must NOT be stripped, otherwise token-mode
  // auth wouldn't work at all.
  it('CLAUDE_CODE_OAUTH_TOKEN is NOT in the strip list', () => {
    expect(API_BILLING_ENV_VARS).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('buildClaudeEnv preserves CLAUDE_CODE_OAUTH_TOKEN', () => {
    const out = buildClaudeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-subscription-token',
      ANTHROPIC_API_KEY: 'nope-stripped',
    });
    expect(out['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat-subscription-token');
    expect(out['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  // Regression: the reject-list gating runtime + startup enforcement covers
  // the known pay-as-you-go API-key sources. Shrinking this would silently
  // accept API-billing traffic.
  it('API_KEY_SOURCE_REJECT covers the known API-billing sources', () => {
    expect(API_KEY_SOURCE_REJECT.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(API_KEY_SOURCE_REJECT.has('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    // Subscription-bound values MUST NOT be in the reject list.
    expect(API_KEY_SOURCE_REJECT.has('none')).toBe(false);
    expect(API_KEY_SOURCE_REJECT.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  });
});
