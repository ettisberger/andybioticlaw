import { describe, it, expect } from 'vitest';
import { chooseModel } from '../../src/agent/route.js';
import type { Config } from '../../src/config/schema.js';

/**
 * The cheap-model router is heuristic. These tests pin each branch of
 * `chooseModel` so a future refactor (e.g. swapping to an LLM-based
 * classifier) is forced to decide what to do with each input type.
 */

function cfg(overrides: Partial<Config['agent']['routing']> = {}, enabled = true): Config {
  // Only the fields chooseModel reads; everything else is `{}` cast
  // through `as unknown as Config` — the test is about the router, not
  // the full schema shape.
  return {
    agent: {
      model: 'claude-opus-4-7',
      haikuModel: 'claude-haiku-4-5-20251001',
      routing: { enabled, minCharsForOpus: 120, ...overrides },
    },
  } as unknown as Config;
}

describe('chooseModel — routing disabled', () => {
  it('always returns the primary model when routing is off', () => {
    const c = cfg({}, false);
    expect(chooseModel('hi', c).model).toBe('claude-opus-4-7');
    expect(chooseModel('summarise my inbox for the week', c).model).toBe('claude-opus-4-7');
    const x = 'x'.repeat(500);
    expect(chooseModel(x, c).model).toBe('claude-opus-4-7');
  });
});

describe('chooseModel — explicit slash-prefix forces tier', () => {
  it('/opus forces opus even for short messages', () => {
    const r = chooseModel('/opus hi', cfg());
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('forced-opus');
  });

  it('/haiku forces haiku even for long/keyword messages', () => {
    const long = '/haiku ' + 'x'.repeat(500);
    const r = chooseModel(long, cfg());
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.reason).toBe('forced-haiku');

    const synthesis = chooseModel('/haiku summarise my day', cfg());
    expect(synthesis.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('chooseModel — voice input → opus', () => {
  it('messages prefixed with the voice tag go to opus', () => {
    const r = chooseModel('[🎙 voice] what is on my calendar today', cfg());
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('voice-input');
  });
});

describe('chooseModel — synthesis keywords → opus', () => {
  it.each([
    'summarise the inbox',
    'Please analyze this log file',
    'Draft an email to Marco',
    'write me a plan for tomorrow',
    'explain what this error means',
    'design a schema for a tasks table',
  ])('keyword in %p routes to Opus', (text) => {
    const r = chooseModel(text, cfg());
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('keyword');
  });
});

describe('chooseModel — "why" / "how" openers → opus', () => {
  it('first-word "why" routes to Opus', () => {
    const r = chooseModel('why did the build fail', cfg());
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('opener');
  });

  it('first-word "how" with punctuation still routes to Opus', () => {
    const r = chooseModel('How? tell me everything', cfg());
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('opener');
  });

  it('"how" mid-sentence is NOT an opener (falls through to length/default)', () => {
    // Short + no keyword + no opener → default Haiku.
    const r = chooseModel('tell me how', cfg());
    expect(r.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('chooseModel — length threshold', () => {
  it('messages at or above minCharsForOpus route to Opus', () => {
    const c = cfg({ minCharsForOpus: 50 });
    const long = 'just some chit-chat to push above the length threshold, nothing special';
    const r = chooseModel(long, c);
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.reason).toBe('length');
  });

  it('short messages below threshold route to Haiku', () => {
    const r = chooseModel('remind me at 3pm', cfg({ minCharsForOpus: 120 }));
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.reason).toBe('default-haiku');
  });
});

describe('chooseModel — default branch', () => {
  it('short, keyword-free, non-voice, non-opener messages default to Haiku', () => {
    const r = chooseModel("what's on my calendar today", cfg());
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.reason).toBe('default-haiku');
  });
});
