import { describe, it, expect, vi } from 'vitest';
import { transcribeWithGroq } from '../../src/telegram/voice.js';

/**
 * Happy path + error behaviour for the Groq Whisper transcription
 * helper. We mock fetch so the tests don't touch the real API.
 */

function makeFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}) {
  return vi.fn(async () => {
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
      text: async () => response.text ?? JSON.stringify(response.body ?? ''),
    } as unknown as Response;
  });
}

describe('transcribeWithGroq', () => {
  it('returns the transcript + duration on a 200 response', async () => {
    const mockFetch = makeFetch({
      ok: true,
      body: { text: '  hello world  ', duration: 1.23 },
    });
    const result = await transcribeWithGroq(Buffer.from('audio-bytes'), {
      apiKey: 'gsk_test',
      fetchImpl: mockFetch,
    });
    expect(result.text).toBe('hello world');
    expect(result.durationSec).toBe(1.23);
    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toMatch(/audio\/transcriptions$/);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer gsk_test',
    });
  });

  it('returns an empty string when the model returned no text', async () => {
    const mockFetch = makeFetch({ ok: true, body: {} });
    const result = await transcribeWithGroq(Buffer.from('silence'), {
      apiKey: 'gsk_test',
      fetchImpl: mockFetch,
    });
    expect(result.text).toBe('');
    expect(result.durationSec).toBeNull();
  });

  it('skips the language field when auto is passed', async () => {
    const formFields: Array<[string, unknown]> = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const fd = init?.body as FormData;
      // Grab the field names so we can assert language is absent.
      fd.forEach((v, k) => formFields.push([k, v]));
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok' }),
        text: async () => '{}',
      } as unknown as Response;
    });
    await transcribeWithGroq(Buffer.from('a'), {
      apiKey: 'gsk_test',
      language: 'auto',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const keys = formFields.map(([k]) => k);
    expect(keys).not.toContain('language');
  });

  it('includes the language field when a specific code is passed', async () => {
    const formFields: Array<[string, unknown]> = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const fd = init?.body as FormData;
      fd.forEach((v, k) => formFields.push([k, v]));
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'ok' }),
        text: async () => '{}',
      } as unknown as Response;
    });
    await transcribeWithGroq(Buffer.from('a'), {
      apiKey: 'gsk_test',
      language: 'de',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const lang = formFields.find(([k]) => k === 'language')?.[1];
    expect(lang).toBe('de');
  });

  it('throws with the response body on a 4xx', async () => {
    const mockFetch = makeFetch({
      ok: false,
      status: 401,
      text: '{"error":{"message":"Invalid API Key"}}',
    });
    await expect(
      transcribeWithGroq(Buffer.from('a'), {
        apiKey: 'gsk_bad',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/HTTP 401.*Invalid API Key/);
  });

  it('throws with the response body on a 5xx', async () => {
    const mockFetch = makeFetch({
      ok: false,
      status: 503,
      text: 'service unavailable',
    });
    await expect(
      transcribeWithGroq(Buffer.from('a'), {
        apiKey: 'gsk_test',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
