import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createTelegramStreamSink } from '../../src/telegram/streaming.js';
import type { SessionExecuteResult } from '../../src/agent/session.js';

/**
 * Regression test for the "missing words mid-sentence" bug.
 *
 * The sink has to batch deltas over a 1200ms edit window. While an
 * `editMessageText` call is awaiting, more deltas can arrive — the sink
 * must NOT clear `pendingTail` unconditionally on completion, or those
 * deltas are silently lost.
 */

function makeFakeApi(opts: { rejectParseWith?: string } = {}) {
  const edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: string;
  }> = [];
  const sends: Array<{ chatId: number; text: string }> = [];
  let nextMessageId = 2000;

  const api = {
    async editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      other?: { parse_mode?: string },
    ) {
      // Simulate a slow Telegram API — 80ms round-trip.
      await new Promise((r) => setTimeout(r, 80));
      if (opts.rejectParseWith && other?.parse_mode) {
        throw new Error(opts.rejectParseWith);
      }
      edits.push({
        chatId,
        messageId,
        text,
        ...(other?.parse_mode ? { parseMode: other.parse_mode } : {}),
      });
      return true as const;
    },
    async sendMessage(chatId: number, text: string) {
      await new Promise((r) => setTimeout(r, 50));
      const id = nextMessageId++;
      sends.push({ chatId, text });
      return { message_id: id } as { message_id: number };
    },
    async sendChatAction() {
      return true as const;
    },
  };
  return { api, edits, sends };
}

const RESULT: SessionExecuteResult = {
  sessionId: 's1',
  status: 'completed',
  tokensInput: 0,
  tokensOutput: 0,
  text: '',
};

describe('TelegramStreamSink — delta coalescing under overlap', () => {
  const logger = pino({ level: 'silent' });

  it('does not lose deltas appended while an edit is in flight', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 's1',
        logger,
        editIntervalMs: 40, // fast ticks to force overlap on the slow (80ms) fake API
        longTaskNotifyAfterMs: 10_000,
      },
      1234,
    );

    // Simulate Claude streaming chunks into onDelta — some arrive before the
    // first flush fires, some arrive DURING the inflight editMessageText.
    sink.onDelta('Hello ');
    await new Promise((r) => setTimeout(r, 45));   // triggers first flush
    sink.onDelta('world, ');                       // arrives during the awaiting edit
    await new Promise((r) => setTimeout(r, 30));
    sink.onDelta('how are you ');                  // arrives still during the edit
    await new Promise((r) => setTimeout(r, 30));
    sink.onDelta('today?');                        // after edit resolves, before next flush

    await sink.onEnd(RESULT);

    // Regardless of how many intermediate edits happened, the final edit
    // must contain the complete concatenation — no bytes dropped.
    expect(edits.length).toBeGreaterThan(0);
    const lastEdit = edits[edits.length - 1]!;
    expect(lastEdit.text).toBe('Hello world, how are you today?');
  });

  it('final flush on onEnd waits for any inflight edit', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 's2',
        logger,
        editIntervalMs: 40,
        longTaskNotifyAfterMs: 10_000,
      },
      1235,
    );

    sink.onDelta('A');
    await new Promise((r) => setTimeout(r, 45));   // kick off flush
    sink.onDelta('B');
    sink.onDelta('C');
    // Call onEnd while the first flush is still likely awaiting the fake API.
    await sink.onEnd({ ...RESULT, sessionId: 's2' });

    const lastEdit = edits[edits.length - 1]!;
    expect(lastEdit.text).toBe('ABC');
  });

  it('preserves deltas even when final edit arrives quickly', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 's3',
        logger,
        editIntervalMs: 40,
        longTaskNotifyAfterMs: 10_000,
      },
      1236,
    );

    // Dense stream with many small deltas.
    const chunks = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog.'];
    for (const chunk of chunks) {
      sink.onDelta(chunk);
      await new Promise((r) => setTimeout(r, 15));
    }

    await sink.onEnd({ ...RESULT, sessionId: 's3' });

    const lastEdit = edits[edits.length - 1]!;
    expect(lastEdit.text).toBe('The quick brown fox jumps over the lazy dog.');
  });
});

describe('TelegramStreamSink — parse_mode', () => {
  const logger = pino({ level: 'silent' });

  it('applies parse_mode only on the final edit; mid-stream edits stay plain', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'p1',
        logger,
        editIntervalMs: 30,
        longTaskNotifyAfterMs: 10_000,
        parseMode: 'HTML',
      },
      1300,
    );

    for (const chunk of ['<b>Hi</b> ', 'there ', 'friend']) {
      sink.onDelta(chunk);
      await new Promise((r) => setTimeout(r, 40));
    }
    await sink.onEnd({ ...RESULT, sessionId: 'p1' });

    // At least two edits: some mid-stream (plain) and one final (HTML).
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const midStreamEdits = edits.slice(0, -1);
    for (const e of midStreamEdits) expect(e.parseMode).toBeUndefined();
    const finalEdit = edits[edits.length - 1]!;
    expect(finalEdit.parseMode).toBe('HTML');
    expect(finalEdit.text).toBe('<b>Hi</b> there friend');
  });

  it("falls back to plain text when Telegram rejects HTML parse entities", async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi({
      rejectParseWith: "Bad Request: can't parse entities: Unclosed start tag at byte offset 3",
    });
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'p2',
        logger,
        editIntervalMs: 30,
        longTaskNotifyAfterMs: 10_000,
        parseMode: 'HTML',
      },
      1301,
    );

    sink.onDelta('<b>oops');
    await new Promise((r) => setTimeout(r, 40));
    await sink.onEnd({ ...RESULT, sessionId: 'p2' });

    const finalPlain = edits[edits.length - 1]!;
    expect(finalPlain.parseMode).toBeUndefined();
    expect(finalPlain.text).toBe('<b>oops');
  });

  it('omits parse_mode entirely when not configured', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'p3',
        logger,
        editIntervalMs: 30,
        longTaskNotifyAfterMs: 10_000,
      },
      1302,
    );
    sink.onDelta('plain text reply');
    await new Promise((r) => setTimeout(r, 40));
    await sink.onEnd({ ...RESULT, sessionId: 'p3' });
    for (const e of edits) expect(e.parseMode).toBeUndefined();
  });
});

describe('TelegramStreamSink — outbound secret redaction', () => {
  const logger = pino({ level: 'silent' });

  it('redacts a known secret value before it reaches editMessageText', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const auditRecorded: Array<{ kind: string; detail: unknown }> = [];
    const audit = {
      record: (row: { kind: string; actor: string; detail: unknown }) => {
        auditRecorded.push({ kind: row.kind, detail: row.detail });
      },
    };
    const secret = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAAA_Q8k3';
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'redact-1',
        logger,
        editIntervalMs: 30,
        longTaskNotifyAfterMs: 10_000,
        audit: audit as never,
        secretsProvider: {
          current: () => new Set([secret]),
        },
      },
      1400,
    );
    // Simulate prompt-injected Emma replying with the raw secret.
    sink.onDelta(`here is your key: ${secret}`);
    await new Promise((r) => setTimeout(r, 40));
    await sink.onEnd({ ...RESULT, sessionId: 'redact-1' });

    // The final edit's text must NOT contain the secret.
    const finalText = edits[edits.length - 1]!.text;
    expect(finalText).not.toContain(secret);
    expect(finalText).toContain('[REDACTED]');
    // An audit row must have been written.
    expect(auditRecorded.some((r) => r.kind === 'agent_secret_leak_blocked')).toBe(true);
  });

  it('deduplicates audit rows per (session, secret) even when the same leak would fire on multiple flushes', async () => {
    vi.useRealTimers();
    const { api } = makeFakeApi();
    const auditRecorded: Array<{ kind: string }> = [];
    const audit = {
      record: (row: { kind: string; actor: string; detail: unknown }) => {
        auditRecorded.push({ kind: row.kind });
      },
    };
    const secret = 'hue_BBBBBBBBBBBBBBBBBBBBBBBB_token';
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'redact-2',
        logger,
        editIntervalMs: 15, // fast flushes to provoke multiple redactions
        longTaskNotifyAfterMs: 10_000,
        audit: audit as never,
        secretsProvider: {
          current: () => new Set([secret]),
        },
      },
      1401,
    );
    // Stream the secret progressively — multiple flushes will each
    // contain it once appended.
    for (const chunk of ['prefix ', secret, ' and ', secret, ' suffix']) {
      sink.onDelta(chunk);
      await new Promise((r) => setTimeout(r, 25));
    }
    await sink.onEnd({ ...RESULT, sessionId: 'redact-2' });

    const leakRows = auditRecorded.filter((r) => r.kind === 'agent_secret_leak_blocked');
    // Even though the secret appeared in many flushes, only ONE audit
    // row should exist for this (session, secret) pair.
    expect(leakRows.length).toBe(1);
  });

  it('passes through clean text untouched when no secret is present', async () => {
    vi.useRealTimers();
    const { api, edits } = makeFakeApi();
    const auditRecorded: Array<unknown> = [];
    const audit = { record: (row: unknown) => auditRecorded.push(row) };
    const sink = createTelegramStreamSink(
      {
        api: api as never,
        chatId: 1000,
        sessionId: 'redact-3',
        logger,
        editIntervalMs: 30,
        longTaskNotifyAfterMs: 10_000,
        audit: audit as never,
        secretsProvider: {
          current: () => new Set(['unrelated_long_token_12345']),
        },
      },
      1402,
    );
    sink.onDelta('hello, here is a normal reply with no secrets');
    await new Promise((r) => setTimeout(r, 40));
    await sink.onEnd({ ...RESULT, sessionId: 'redact-3' });

    const finalText = edits[edits.length - 1]!.text;
    expect(finalText).toBe('hello, here is a normal reply with no secrets');
    expect(auditRecorded.length).toBe(0);
  });
});
