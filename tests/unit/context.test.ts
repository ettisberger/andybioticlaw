import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/agent/context.js';
import type { MessageRecord } from '../../src/db/repositories/messages.js';

function msg(
  overrides: Partial<MessageRecord> & Pick<MessageRecord, 'role' | 'content'>,
): MessageRecord {
  return {
    id: 0,
    session_id: 's',
    chat_id: 'c',
    telegram_message_id: null,
    created_at: Date.now(),
    ...overrides,
  } as MessageRecord;
}

describe('assembleContext', () => {
  const base = {
    agentName: 'Emma',
    model: 'claude-opus-4-7',
    timezone: 'Europe/Zurich',
    principalLabel: 'Telegram user 18998064',
  };

  it('substitutes {{agent.name}} in the base prompt', () => {
    const ctx = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
    });
    expect(ctx.systemPrompt).toMatch(/You are Emma,/);
    expect(ctx.systemPrompt).not.toMatch(/\{\{agent.name\}\}/);
  });

  it('renders active memory as a bullet list', () => {
    const ctx = assembleContext({
      ...base,
      activeMemory: [
        { scope: 'global', key: 'pref/timezone', value: 'user is in CET' },
        { scope: 'user:1', key: null, value: 'prefers German' },
      ],
      activeSkills: [],
      conversationHistory: [],
    });
    expect(ctx.systemPrompt).toMatch(/## Active memory/);
    expect(ctx.systemPrompt).toMatch(/\[global · pref\/timezone\] user is in CET/);
    expect(ctx.systemPrompt).toMatch(/\[user:1\] prefers German/);
  });

  it('includes conversation history in chronological order', () => {
    const history = [
      msg({ role: 'user', content: 'What did we discuss earlier?' }),
      msg({ role: 'assistant', content: 'We discussed timezones.' }),
    ];
    const ctx = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: history,
    });
    const historyIdx = ctx.systemPrompt.indexOf('## Conversation history');
    expect(historyIdx).toBeGreaterThan(0);
    const historyBlock = ctx.systemPrompt.slice(historyIdx);
    expect(historyBlock.indexOf('User: What did we discuss earlier?')).toBeGreaterThan(0);
    expect(historyBlock.indexOf('Assistant: We discussed timezones.')).toBeGreaterThan(0);
    // Order: user line before assistant line.
    expect(historyBlock.indexOf('User:')).toBeLessThan(historyBlock.indexOf('Assistant:'));
  });

  it('trims oldest history when over budget', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      msg({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(100) }),
    );
    const ctx = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: msgs,
      historyBudgetChars: 400,
    });
    expect(ctx.trimmedHistoryMessages).toBeGreaterThan(0);
    expect(ctx.trimmedHistoryMessages).toBeLessThan(msgs.length);
  });

  it('renders skill SKILL.md under Installed skills', () => {
    const ctx = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [
        { name: 'calendar', skillMdContent: '# calendar\n\nReads Google Calendar.' },
      ],
      conversationHistory: [],
    });
    expect(ctx.systemPrompt).toMatch(/## Installed skills/);
    expect(ctx.systemPrompt).toMatch(/### calendar/);
    expect(ctx.systemPrompt).toMatch(/Reads Google Calendar/);
  });

  it('orders sections cache-stable → cache-volatile (base/memory/skills/meta BEFORE history/time)', () => {
    const ctx = assembleContext({
      ...base,
      activeMemory: [{ scope: 'global', key: null, value: 'x' }],
      activeSkills: [{ name: 's', skillMdContent: '# s' }],
      memoryToolDescribed: true,
      conversationHistory: [msg({ role: 'user', content: 'hi' })],
    });
    const p = ctx.systemPrompt;
    const iBase = p.indexOf('You are Emma');
    const iMem = p.indexOf('## Active memory');
    const iSkill = p.indexOf('## Installed skills');
    const iTool = p.indexOf('## Memory tool');
    const iMeta = p.indexOf('## Runtime context');
    const iHistory = p.indexOf('## Conversation history');
    const iTime = p.indexOf('## Current time');
    // All present
    for (const [label, idx] of Object.entries({ iBase, iMem, iSkill, iTool, iMeta, iHistory, iTime })) {
      expect(idx, `${label} is missing`).toBeGreaterThanOrEqual(0);
    }
    // Stable prefix in order.
    expect(iBase).toBeLessThan(iMem);
    expect(iMem).toBeLessThan(iSkill);
    expect(iSkill).toBeLessThan(iTool);
    expect(iTool).toBeLessThan(iMeta);
    // Volatile suffix AFTER stable meta.
    expect(iMeta).toBeLessThan(iHistory);
    expect(iHistory).toBeLessThan(iTime);
  });

  it('stable meta does NOT contain a timestamp', () => {
    const ctx = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
    });
    const metaIdx = ctx.systemPrompt.indexOf('## Runtime context');
    const timeIdx = ctx.systemPrompt.indexOf('## Current time');
    const metaBlock = ctx.systemPrompt.slice(metaIdx, timeIdx);
    // The stable meta should not mention "time" at all — the Current time
    // lives in its own volatile footer. Regression guard for the cache fix.
    expect(metaBlock.toLowerCase()).not.toMatch(/current time/);
  });

  it('current time is rounded down to the 15-minute bucket (default)', () => {
    // Fix `now` to 2026-04-22 12:07:42 UTC. 15-min buckets are at :00, :15, :30, :45.
    // Expected rendered bucket in Europe/Zurich (UTC+2 CEST 2026-04-22): 14:00.
    const fixed = Date.UTC(2026, 3, 22, 12, 7, 42);
    const ctxA = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed,
    });
    // Now 6 minutes later — still in the same bucket.
    const ctxB = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed + 6 * 60_000,
    });
    expect(ctxA.systemPrompt).toBe(ctxB.systemPrompt);

    // Jump to the next bucket (now + 10 min from the original → crosses :15).
    const ctxC = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed + 10 * 60_000,
    });
    expect(ctxC.systemPrompt).not.toBe(ctxA.systemPrompt);

    // Both render a formatted time, but rounded to the bucket.
    expect(ctxA.systemPrompt).toMatch(/## Current time[\s\S]*Europe\/Zurich/);
  });

  it('custom timeBucketMs lets callers tighten or relax the cache window', () => {
    // Pick a time safely away from the minute boundary so +20s stays in
    // the same bucket and +90s definitely crosses into the next one.
    const fixed = Date.UTC(2026, 3, 22, 12, 7, 5); // 12:07:05 UTC
    const tight = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed,
      timeBucketMs: 60_000, // 1-min bucket
    });
    const tightPlus20s = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed + 20_000, // 12:07:25 — same :07 minute
      timeBucketMs: 60_000,
    });
    expect(tight.systemPrompt).toBe(tightPlus20s.systemPrompt);

    const tightPlus90s = assembleContext({
      ...base,
      activeMemory: [],
      activeSkills: [],
      conversationHistory: [],
      nowMs: fixed + 90_000, // 12:08:35 — next :08 minute
      timeBucketMs: 60_000,
    });
    expect(tightPlus90s.systemPrompt).not.toBe(tight.systemPrompt);
  });

  it('entire prefix BEFORE the history block is cache-stable across quick turns', () => {
    const fixed = Date.UTC(2026, 3, 22, 12, 7, 42);
    const history1 = [msg({ role: 'user', content: 'first' })];
    const history2 = [...history1, msg({ role: 'assistant', content: 'first reply' })];

    const a = assembleContext({
      ...base,
      activeMemory: [{ scope: 'global', key: null, value: 'stable' }],
      activeSkills: [],
      memoryToolDescribed: true,
      conversationHistory: history1,
      nowMs: fixed,
    });
    // Later in the same bucket, history grew by two messages.
    const b = assembleContext({
      ...base,
      activeMemory: [{ scope: 'global', key: null, value: 'stable' }],
      activeSkills: [],
      memoryToolDescribed: true,
      conversationHistory: history2,
      nowMs: fixed + 2 * 60_000,
    });

    const iHistoryA = a.systemPrompt.indexOf('## Conversation history');
    const iHistoryB = b.systemPrompt.indexOf('## Conversation history');
    // The prefix (everything up to and NOT including the history heading)
    // is byte-for-byte identical — i.e. the prompt cache can re-use it.
    expect(a.systemPrompt.slice(0, iHistoryA)).toBe(b.systemPrompt.slice(0, iHistoryB));
  });
});
