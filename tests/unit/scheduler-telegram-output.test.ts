import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { createSchedulerTelegramSink } from '../../src/scheduler/telegram-output.js';

/**
 * The scheduler sink is what fires for every `--message` agent-task
 * (notably the daily digest). Locks down:
 *
 * - parse_mode: 'HTML' is set on every send (Telegram needs to render
 *   <b>/<i>/<a> tags Emma emits — without it, the raw markup leaks
 *   through as literal text, which is the bug the user just hit on
 *   their daily digest).
 * - Operator-supplied schedule names get HTML-escaped before going
 *   inside <b>...</b> so a name like "Build & Deploy" doesn't trigger
 *   the parse-entities fallback.
 * - Malformed HTML in the agent's reply triggers a plain-text resend
 *   so the principal sees content, not nothing.
 * - The completed-but-empty case is silent (no message sent).
 */

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger;
}

describe('createSchedulerTelegramSink', () => {
  it('sends with parse_mode: HTML on the completed-output path', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 18998064,
      scheduleName: 'daily-digest',
      logger: makeLogger(),
    });
    sink.onDelta('Heute auf dem Kalender:\n<b>10:00</b> — Standup');
    await sink.onEnd({
      status: 'completed',
      sessionId: 'test-session',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text, opts] = sendMessage.mock.calls[0] ?? [];
    expect(opts).toEqual({ parse_mode: 'HTML' });
    expect(text).toContain('<b>daily-digest</b>');
    expect(text).toContain('<b>10:00</b>');
  });

  it('escapes operator-supplied schedule names that contain HTML metacharacters', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 1,
      scheduleName: 'Build & Deploy <prod>',
      logger: makeLogger(),
    });
    sink.onDelta('done');
    await sink.onEnd({
      status: 'completed',
      sessionId: 's',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
    });
    const [, text] = sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('<b>Build &amp; Deploy &lt;prod&gt;</b>');
    // The raw `<prod>` must NOT appear inside the bold tag (would
    // trigger Telegram's parse-entities fallback).
    expect(text).not.toContain('Build & Deploy <prod>');
  });

  it('falls back to plain text when Telegram rejects malformed HTML', async () => {
    let call = 0;
    const sendMessage = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw new Error("Bad Request: can't parse entities: unmatched tag at offset 42");
      }
      return {};
    });
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 1,
      scheduleName: 'broken-html',
      logger: makeLogger(),
    });
    sink.onDelta('Emma forgot a closing tag <b>oops');
    await sink.onEnd({
      status: 'completed',
      sessionId: 's',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // First call attempted HTML; second was plain-text retry.
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ parse_mode: 'HTML' });
    expect(sendMessage.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('does NOT retry on non-parse-entities errors (one log + drop)', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: chat not found'));
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 999999999,
      scheduleName: 's',
      logger: makeLogger(),
    });
    sink.onDelta('hi');
    await sink.onEnd({
      status: 'completed',
      sessionId: 'sid',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('skips sending entirely when the session completed with no output', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 1,
      scheduleName: 's',
      logger: makeLogger(),
    });
    // No onDelta calls.
    await sink.onEnd({
      status: 'completed',
      sessionId: 'sid',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('failed status sends with HTML and includes escaped error text', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sink = createSchedulerTelegramSink({
      api: { sendMessage } as never,
      chatId: 1,
      scheduleName: 's',
      logger: makeLogger(),
    });
    await sink.onEnd({
      status: 'failed',
      sessionId: 'sid',
      tokensInput: 0,
      tokensOutput: 0,
      text: '',
      error: 'Connection refused <127.0.0.1:5432>',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, text, opts] = sendMessage.mock.calls[0] ?? [];
    expect(opts).toEqual({ parse_mode: 'HTML' });
    expect(text).toContain('<i>error: Connection refused &lt;127.0.0.1:5432&gt;</i>');
  });
});
