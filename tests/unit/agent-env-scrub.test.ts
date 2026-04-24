import { describe, it, expect } from 'vitest';
import { AGENT_SCRUBBED_SECRETS, buildClaudeEnv } from '../../src/agent/runner.js';

/**
 * buildClaudeEnv is the chokepoint for "what env vars Emma's
 * subprocess sees". These tests pin the scrub list so adding a new
 * CORE_SECRETS value in future doesn't silently start leaking it
 * into Emma's env without anyone noticing.
 */

describe('buildClaudeEnv — secret scrubbing', () => {
  it('drops TELEGRAM_BOT_TOKEN from the child env', () => {
    const env = buildClaudeEnv({ TELEGRAM_BOT_TOKEN: '123:ABC', FOO: 'keep' });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.FOO).toBe('keep');
  });

  it('drops GROQ_API_KEY from the child env', () => {
    const env = buildClaudeEnv({ GROQ_API_KEY: 'gsk_xxx', FOO: 'keep' });
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.FOO).toBe('keep');
  });

  it('keeps CLAUDE_CODE_OAUTH_TOKEN (Claude CLI needs it for subscription auth)', () => {
    const env = buildClaudeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'eyJhbGc...',
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('eyJhbGc...');
  });

  it('keeps arbitrary unrelated env vars (PATH, HOME, …) intact', () => {
    const env = buildClaudeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/andybioticlaw',
      NODE_ENV: 'production',
    });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/andybioticlaw');
    expect(env.NODE_ENV).toBe('production');
  });

  it('keeps skill-scoped secrets intact (they flow via extraEnv, not scrubbed here)', () => {
    // Skill secrets like GOOGLE_CALENDAR_REFRESH_TOKEN / HUE_* / SMTP_PASS
    // are re-injected per-session via extraEnv in session.ts — on purpose:
    // some skill bash wrappers (himalaya) need them in the env. This
    // scrubbing layer is only for core secrets Emma doesn't need at all.
    const env = buildClaudeEnv({
      GOOGLE_CALENDAR_REFRESH_TOKEN: 'rt_abc',
      HUE_ACCESS_TOKEN: 'hue_xyz',
      SMTP_PASS: 'smtp_pw',
    });
    expect(env.GOOGLE_CALENDAR_REFRESH_TOKEN).toBe('rt_abc');
    expect(env.HUE_ACCESS_TOKEN).toBe('hue_xyz');
    expect(env.SMTP_PASS).toBe('smtp_pw');
  });

  it('exports AGENT_SCRUBBED_SECRETS so other code can reference the list', () => {
    expect(AGENT_SCRUBBED_SECRETS).toContain('TELEGRAM_BOT_TOKEN');
    expect(AGENT_SCRUBBED_SECRETS).toContain('GROQ_API_KEY');
    expect(AGENT_SCRUBBED_SECRETS).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
