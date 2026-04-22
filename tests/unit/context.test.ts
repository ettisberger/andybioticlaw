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
});
