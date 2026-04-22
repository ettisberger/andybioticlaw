import { describe, it, expect } from 'vitest';
import { parsePayload, parseTrigger, SchedulePayloadError } from '../../src/scheduler/payloads.js';

describe('parsePayload', () => {
  it('parses a valid bash payload', () => {
    const p = parsePayload('bash', JSON.stringify({ command: 'echo ok', timeoutSec: 10 }));
    expect(p.command).toBe('echo ok');
    expect(p.timeoutSec).toBe(10);
  });

  it('applies defaults (bash.timeoutSec)', () => {
    const p = parsePayload('bash', JSON.stringify({ command: 'true' }));
    expect(p.timeoutSec).toBe(30);
  });

  it('rejects bash without command', () => {
    expect(() => parsePayload('bash', '{}')).toThrow(SchedulePayloadError);
  });

  it('parses http-check with defaults', () => {
    const p = parsePayload('http-check', JSON.stringify({ url: 'https://example.com' }));
    expect(p.method).toBe('GET');
    expect(p.timeoutSec).toBe(15);
  });

  it('rejects http-check with invalid URL', () => {
    expect(() => parsePayload('http-check', JSON.stringify({ url: 'not-a-url' }))).toThrow(
      SchedulePayloadError,
    );
  });

  it('parses agent-task', () => {
    const p = parsePayload('agent-task', JSON.stringify({ prompt: 'hi', chatId: '42' }));
    expect(p.prompt).toBe('hi');
    expect(p.chatId).toBe('42');
  });

  it('parses reminder', () => {
    const p = parsePayload('reminder', JSON.stringify({ text: 'standup in 10 min' }));
    expect(p.text).toBe('standup in 10 min');
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePayload('reminder', 'not json')).toThrow(SchedulePayloadError);
  });
});

describe('parseTrigger', () => {
  it('extracts trigger envelope from stdout', () => {
    const t = parseTrigger('{"trigger": true, "prompt": "summarize"}');
    expect(t?.prompt).toBe('summarize');
  });

  it('returns null for non-trigger JSON', () => {
    expect(parseTrigger('{"ok": true}')).toBeNull();
  });

  it('returns null for non-JSON stdout', () => {
    expect(parseTrigger('just some text')).toBeNull();
  });

  it('returns null when trigger is false', () => {
    expect(parseTrigger('{"trigger": false, "prompt": "x"}')).toBeNull();
  });

  it('handles leading whitespace', () => {
    const t = parseTrigger('   \n  {"trigger": true, "prompt": "x"}\n');
    expect(t?.prompt).toBe('x');
  });
});
