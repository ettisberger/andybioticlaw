import { describe, it, expect, afterEach } from 'vitest';
import { API_BILLING_ENV_VARS } from '../../src/agent/credentials.js';
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
});
