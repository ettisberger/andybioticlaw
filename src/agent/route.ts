/**
 * Cheap model router.
 *
 * Every DM today spends Opus-rate tokens. Simple queries ("what's on
 * my calendar today") get routed to Haiku (~0.05× the cost) when the
 * operator opts in; complex ones keep hitting Opus.
 *
 * Intentionally a length+keyword heuristic rather than an LLM-based
 * classifier — 80% of the savings at 1% of the complexity. Upgrade
 * path is in docs/ROADMAP.md.
 */

import type { Config } from '../config/schema.js';

/**
 * Keywords that strongly indicate a long-form / synthesis task and
 * should force Opus. Matched as word-boundaried substrings.
 */
export const OPUS_KEYWORDS = [
  'summarise',
  'summarize',
  'analyse',
  'analyze',
  'draft',
  'write me',
  'code',
  'plan',
  'design',
  'explain',
] as const;

/**
 * First-word openers that indicate "why/how" questions — usually more
 * involved than short commands.
 */
const OPUS_OPENERS = ['why', 'how'] as const;

/**
 * Voice-input prefix prepended by the DM handler. Voice inputs are
 * usually long-form / conversational, so we always go to Opus.
 */
const VOICE_PREFIX = '[🎙 voice]';

/**
 * Slash-prefixes that let the user force a tier regardless of heuristics.
 */
const FORCE_OPUS = ['/opus'];
const FORCE_HAIKU = ['/haiku'];

export interface ChooseModelResult {
  model: string;
  /** Reason we picked this model — useful for audit/debug. */
  reason:
    | 'routing-disabled'
    | 'forced-opus'
    | 'forced-haiku'
    | 'voice-input'
    | 'keyword'
    | 'opener'
    | 'length'
    | 'default-haiku';
}

/**
 * Decide which Claude model to use for a given user message. Pure;
 * trivially unit-testable.
 */
export function chooseModel(userMessage: string, config: Config): ChooseModelResult {
  const primary = config.agent.model;
  const haiku = config.agent.haikuModel;
  const routing = config.agent.routing;

  // Routing disabled → always primary (current behaviour).
  if (!routing.enabled) {
    return { model: primary, reason: 'routing-disabled' };
  }

  const text = userMessage.trim();
  const lower = text.toLowerCase();

  // 1. Explicit slash-prefix forces a tier.
  for (const prefix of FORCE_OPUS) {
    if (lower.startsWith(prefix)) return { model: primary, reason: 'forced-opus' };
  }
  for (const prefix of FORCE_HAIKU) {
    if (lower.startsWith(prefix)) return { model: haiku, reason: 'forced-haiku' };
  }

  // 2. Voice input → Opus (tends to be long-form).
  if (text.startsWith(VOICE_PREFIX)) {
    return { model: primary, reason: 'voice-input' };
  }

  // 3. Synthesis keywords → Opus.
  for (const kw of OPUS_KEYWORDS) {
    if (lower.includes(kw)) return { model: primary, reason: 'keyword' };
  }

  // 4. "Why" / "how" openers → Opus.
  const firstWord = lower.split(/\s+/)[0] ?? '';
  const opener = firstWord.replace(/[?.,!:;]+$/, '');
  if ((OPUS_OPENERS as readonly string[]).includes(opener)) {
    return { model: primary, reason: 'opener' };
  }

  // 5. Long message → Opus.
  if (text.length >= routing.minCharsForOpus) {
    return { model: primary, reason: 'length' };
  }

  // 6. Default: Haiku.
  return { model: haiku, reason: 'default-haiku' };
}
