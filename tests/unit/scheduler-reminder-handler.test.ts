import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { reminderHandler } from '../../src/scheduler/handlers/reminder.js';
import type { HandlerContext } from '../../src/scheduler/handlers/types.js';
import type { ScheduleRecord } from '../../src/db/repositories/schedules.js';

/**
 * The reminder handler is the second Telegram-output path that needed
 * parse_mode HTML (the first was the agent-task sink). Pin:
 *   - parse_mode is set on the wire
 *   - schedule name is HTML-escaped before going in <b>...</b>
 *   - parse-entities errors trigger the plain-text fallback (so a
 *     malformed --reminder body doesn't make the reminder vanish)
 *   - non-parse-entities errors also don't crash the handler — the
 *     shared sendTelegramHtml swallows them and logs
 */

function makeLogger(): Logger {
  const log: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => log),
  } as unknown as Logger;
  return log;
}

function makeSchedule(name: string): ScheduleRecord {
  return {
    id: 1,
    name,
    cron_expr: '0 9 * * *',
    kind: 'reminder',
    payload: '{"text":"unused"}',
    context: null,
    enabled: 1,
    recurring: 0,
    budget_tokens_per_day: null,
    budget_used_today: 0,
    budget_reset_at: null,
    last_run: null,
    next_run: null,
    consecutive_fails: 0,
    created_at: Date.now(),
  };
}

function makeCtx(opts: {
  scheduleName: string;
  defaultChatId: number | null;
  sendMessage: ReturnType<typeof vi.fn>;
}): HandlerContext {
  return {
    schedule: makeSchedule(opts.scheduleName),
    logger: makeLogger(),
    telegramApi: { sendMessage: opts.sendMessage } as never,
    defaultChatId: opts.defaultChatId,
    queue: {} as never,
    submitAgentTask: vi.fn(),
  };
}

describe('reminderHandler', () => {
  it('sends with parse_mode: HTML and the schedule name as bold header', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      scheduleName: 'augenarzt-termin',
      defaultChatId: 18998064,
      sendMessage,
    });
    const result = await reminderHandler.run(
      { text: 'Augenarzt um 09:00 — Praxis Müller' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, sendOpts] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe(18998064);
    expect(sendOpts).toEqual({ parse_mode: 'HTML' });
    expect(text).toContain('⏰ <b>augenarzt-termin</b>');
    expect(text).toContain('Augenarzt um 09:00 — Praxis Müller');
  });

  it('escapes operator-supplied schedule names with HTML metacharacters', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      scheduleName: 'Build & Deploy <prod>',
      defaultChatId: 1,
      sendMessage,
    });
    await reminderHandler.run({ text: 'go' }, ctx);
    const [, text] = sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('<b>Build &amp; Deploy &lt;prod&gt;</b>');
    expect(text).not.toContain('Build & Deploy <prod></b>');
  });

  it('uses payload.chatId when set, ignoring defaultChatId', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      scheduleName: 's',
      defaultChatId: 18998064,
      sendMessage,
    });
    await reminderHandler.run({ text: 'hi', chatId: '-100123' }, ctx);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(-100123);
  });

  it('falls back to plain text when Telegram rejects malformed HTML', async () => {
    let call = 0;
    const sendMessage = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw new Error("Bad Request: can't parse entities: unmatched tag at offset 5");
      }
      return {};
    });
    const ctx = makeCtx({
      scheduleName: 'broken',
      defaultChatId: 1,
      sendMessage,
    });
    const result = await reminderHandler.run(
      { text: 'oops <b>not closed' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ parse_mode: 'HTML' });
    expect(sendMessage.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('returns success even when send fails for non-parse-entities reason (helper logs and swallows)', async () => {
    // The shared sendTelegramHtml swallows transport errors so the
    // schedule run row records "success" — this matches what we
    // already do for agent-task. The principal sees no message, but
    // the schedule isn't auto-disabled for one transient blip.
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: chat not found'));
    const ctx = makeCtx({
      scheduleName: 's',
      defaultChatId: 999999999,
      sendMessage,
    });
    const result = await reminderHandler.run({ text: 'hi' }, ctx);
    expect(result.status).toBe('success');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('fails when there is no payload.chatId and no defaultChatId', async () => {
    const sendMessage = vi.fn();
    const ctx = makeCtx({
      scheduleName: 's',
      defaultChatId: null,
      sendMessage,
    });
    const result = await reminderHandler.run({ text: 'hi' }, ctx);
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/no chatId/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fails when chatId is not a finite number', async () => {
    const sendMessage = vi.fn();
    const ctx = makeCtx({
      scheduleName: 's',
      defaultChatId: 1,
      sendMessage,
    });
    const result = await reminderHandler.run(
      { text: 'hi', chatId: 'not-a-number' },
      ctx,
    );
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/invalid chatId/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
