import type { Api } from 'grammy';

/**
 * Voice-input preprocessor: download Telegram voice blobs and transcribe
 * them via Groq's Whisper Large v3 (OpenAI-compatible endpoint).
 *
 * Shape rationale:
 *   - `downloadVoiceMessage` and `transcribeWithGroq` are independent
 *     pure-ish functions (each takes what it needs, returns a Buffer /
 *     text). That makes them trivially unit-testable with a mocked
 *     `fetch` without also having to fake grammy's full Api object.
 *   - No retry logic here. Transient failures bubble up and the DM
 *     handler surfaces them to the user in chat ("transcription failed
 *     — try again"). Retries would delay the already-slow voice UX
 *     without helping much; a failed retry still costs the user their
 *     message.
 */

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_DEFAULT_MODEL = 'whisper-large-v3';

export interface TranscribeOptions {
  apiKey: string;
  /** `'auto'` (default) lets Whisper detect; anything else is a BCP-47 / ISO-639-1 code. */
  language?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Default: the configured Groq endpoint. */
  endpoint?: string;
  /** Override for tests. Default: `whisper-large-v3`. */
  model?: string;
}

export interface TranscribeResult {
  /** The transcript, trimmed. Empty string if the model produced nothing. */
  text: string;
  /** Approximate audio duration in seconds, if Groq reported one (verbose_json). */
  durationSec: number | null;
}

/**
 * Download a Telegram file (voice note, audio, whatever) to an in-memory
 * Buffer. Matches the pattern used for the bot-avatar fetch in
 * `src/telegram/bot.ts`. Throws on HTTP errors — callers decide how to
 * surface that to the user.
 *
 * The Telegram Bot API caps downloads at 20 MB. Voice messages are
 * typically ~100 KB per 30s of audio (opus), so we're nowhere near it,
 * but the caller should still have enforced a duration cap upstream so
 * a 20-minute rant doesn't show up.
 */
export async function downloadVoiceMessage(
  api: Api,
  fileId: string,
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const fileInfo = await api.getFile(fileId);
  if (!fileInfo.file_path) {
    throw new Error(`Telegram did not return a file_path for file_id=${fileId}`);
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * POST an audio buffer to Groq's Whisper endpoint and return the
 * transcribed text. Uses `response_format=verbose_json` so we can
 * optionally pluck duration info; `text`-format would be cheaper but
 * less informative.
 *
 * On non-2xx, throws with the raw response body included — matches the
 * diagnostic style we use in google-calendar's install.sh so the
 * operator can see why Groq rejected the request (rate limit vs bad
 * key vs corrupt audio).
 */
export async function transcribeWithGroq(
  audio: Buffer,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? GROQ_TRANSCRIBE_URL;
  const model = opts.model ?? GROQ_DEFAULT_MODEL;

  const form = new FormData();
  // Telegram voice is ogg/opus. Filename matters for Groq's type sniff.
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (opts.language && opts.language !== 'auto') {
    form.append('language', opts.language);
  }

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Groq transcription failed: HTTP ${res.status} ${body.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as { text?: unknown; duration?: unknown };
  const text = typeof json.text === 'string' ? json.text.trim() : '';
  const durationSec =
    typeof json.duration === 'number' ? json.duration : null;
  return { text, durationSec };
}
