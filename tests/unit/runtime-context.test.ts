import { describe, it, expect } from 'vitest';
import {
  contextKey,
  parseContextKey,
  resolveBinding,
  synthesizeAgentsFromLegacy,
  synthesizeDefaultBindings,
} from '../../src/agent/runtime-context.js';
import type { AgentConfigEntry, BindingRule } from '../../src/config/schema.js';

/**
 * The binding resolver is the only thing standing between an incoming
 * Telegram message and the wrong agent answering it. Lock the precedence
 * matrix here.
 */

const emma: AgentConfigEntry = {
  id: 'emma',
  name: 'Emma',
  default: true,
  model: 'claude-opus-4-7',
  haikuModel: 'claude-haiku-4-5-20251001',
  credentialsDir: '~/.claude',
  streamIdleTimeoutSec: 300,
  routing: { enabled: false, minCharsForOpus: 120 },
  skills: ['*'],
};
const work: AgentConfigEntry = {
  ...emma,
  id: 'work',
  name: 'Work Emma',
  default: false,
  skills: ['notes'],
};

describe('contextKey + parseContextKey', () => {
  it('round-trips a typical context', () => {
    const ctx = { agentId: 'emma', channel: 'telegram' as const, chatId: 18998064 };
    expect(contextKey(ctx)).toBe('emma:telegram:18998064');
    expect(parseContextKey('emma:telegram:18998064')).toEqual(ctx);
  });

  it('returns null for malformed input', () => {
    expect(parseContextKey('emma:telegram')).toBeNull();
    expect(parseContextKey('emma:slack:1')).toBeNull();
    expect(parseContextKey('emma:telegram:not-a-number')).toBeNull();
  });
});

describe('resolveBinding', () => {
  it('falls back to the default agent when no binding matches', () => {
    const ctx = resolveBinding(
      { channel: 'telegram', chatId: 1, userId: 1 },
      [],
      [emma],
    );
    expect(ctx.agentId).toBe('emma');
    expect(ctx.chatId).toBe(1);
  });

  it('throws when no rule matches AND no default agent is configured', () => {
    expect(() =>
      resolveBinding(
        { channel: 'telegram', chatId: 1, userId: 1 },
        [],
        [{ ...emma, default: false }],
      ),
    ).toThrow(/no binding rule matched/);
  });

  it('catch-all channel rule wins over default-agent fallback', () => {
    const rules: BindingRule[] = [
      { agentId: 'work', match: { channel: 'telegram' } },
    ];
    const ctx = resolveBinding(
      { channel: 'telegram', chatId: 1, userId: 1 },
      rules,
      [emma, work],
    );
    expect(ctx.agentId).toBe('work');
  });

  it('chat-id match wins over channel-only rule', () => {
    const rules: BindingRule[] = [
      { agentId: 'emma', match: { channel: 'telegram' } },
      { agentId: 'work', match: { channel: 'telegram', chatIds: [-100] } },
    ];
    const ctx = resolveBinding(
      { channel: 'telegram', chatId: -100, userId: 5 },
      rules,
      [emma, work],
    );
    expect(ctx.agentId).toBe('work');
  });

  it('chat-id + user-id (most specific) wins over chat-id-only', () => {
    const rules: BindingRule[] = [
      { agentId: 'emma', match: { channel: 'telegram', chatIds: [-100] } },
      { agentId: 'work', match: { channel: 'telegram', chatIds: [-100], userIds: [5] } },
    ];
    const ctx = resolveBinding(
      { channel: 'telegram', chatId: -100, userId: 5 },
      rules,
      [emma, work],
    );
    expect(ctx.agentId).toBe('work');
  });

  it('user-id-only rule fires when its user matches even on a different chat', () => {
    const rules: BindingRule[] = [
      { agentId: 'emma', match: { channel: 'telegram' } },
      { agentId: 'work', match: { channel: 'telegram', userIds: [5] } },
    ];
    const ctx = resolveBinding(
      { channel: 'telegram', chatId: 999, userId: 5 },
      rules,
      [emma, work],
    );
    expect(ctx.agentId).toBe('work');
  });

  it('non-matching specific rule yields to a less-specific match', () => {
    const rules: BindingRule[] = [
      { agentId: 'emma', match: { channel: 'telegram' } },
      { agentId: 'work', match: { channel: 'telegram', chatIds: [-200] } },
    ];
    const ctx = resolveBinding(
      // Different chat id from the work rule.
      { channel: 'telegram', chatId: -100, userId: 5 },
      rules,
      [emma, work],
    );
    expect(ctx.agentId).toBe('emma');
  });
});

describe('synthesizeAgentsFromLegacy + synthesizeDefaultBindings', () => {
  it('builds a single-default agent named "emma"', () => {
    const synthesized = synthesizeAgentsFromLegacy({
      name: 'Emma',
      model: 'claude-opus-4-7',
      haikuModel: 'claude-haiku-4-5-20251001',
      credentialsDir: '~/.claude',
      streamIdleTimeoutSec: 300,
      routing: { enabled: false, minCharsForOpus: 120 },
    });
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]?.id).toBe('emma');
    expect(synthesized[0]?.default).toBe(true);
    expect(synthesized[0]?.skills).toEqual(['*']);
  });

  it('default binding sends everything to the chosen agent', () => {
    const bindings = synthesizeDefaultBindings('emma');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.agentId).toBe('emma');
    expect(bindings[0]?.match.channel).toBe('telegram');
    // No chatIds / userIds restriction = catch-all.
    expect(bindings[0]?.match.chatIds).toBeUndefined();
    expect(bindings[0]?.match.userIds).toBeUndefined();
  });
});
