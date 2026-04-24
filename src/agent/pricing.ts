/**
 * Estimated cost calculation against Anthropic's public API list prices.
 *
 * IMPORTANT: this service runs on subscription auth. The numbers produced
 * here are NOT what you're billed — Anthropic charges the subscription
 * flat rate. Use this as a **consumption proxy** (how much a session
 * would cost someone on pay-as-you-go), surfaced in the dashboard with
 * a clear caveat chip.
 *
 * Rates: $ per million input/output tokens. Update `MODEL_RATES_VERSION`
 * whenever the table changes so stale rates are visible in the UI.
 */

/** Date (YYYY-MM-DD) the rates below were last checked against Anthropic docs. */
export const MODEL_RATES_VERSION = '2026-04-24';

/** Per-Mtoken rates. Keyed by the model-family prefix (no dated suffix) —
 *  `estimateUsd` does prefix matching so `claude-haiku-4-5-20251001`
 *  resolves to the `claude-haiku-4-5` entry. */
export const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-opus-4-6': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 0.25, out: 1.25 },
};

/**
 * Compute the API-list-price equivalent USD for a session's token counts.
 * Returns `null` when the model is unknown or not provided — callers
 * render that as `'—'`, NEVER as `$0` (which would silently understate
 * real usage).
 */
export function estimateUsd(
  model: string | null,
  tokensIn: number,
  tokensOut: number,
): number | null {
  if (!model) return null;
  // Prefix match: longest known prefix that matches the start of `model`.
  // Sorted so `claude-opus-4-7` is tried before `claude-opus-4` (should
  // one ever be added as a separate family).
  const keys = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model === key || model.startsWith(`${key}-`)) {
      const rate = MODEL_RATES[key]!;
      return (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
    }
  }
  return null;
}

/**
 * Render a USD amount with friendly formatting:
 *   null          → '—'
 *   0             → '$0.00'
 *   0.00123       → '<$0.01'
 *   1.234         → '$1.23'
 *   1234.56       → '$1.2k'
 *   1234567       → '$1.2M'
 */
export function formatUsd(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '$0.00';
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}
