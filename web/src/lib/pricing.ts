/**
 * Frontend mirror of `src/agent/pricing.ts`. Kept in sync manually —
 * there's no shared package. When updating rates, edit both files.
 *
 * @see /src/agent/pricing.ts
 */

export const MODEL_RATES_VERSION = '2026-04-24';

export const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-opus-4-6': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 0.25, out: 1.25 },
};

export function estimateUsd(
  model: string | null,
  tokensIn: number,
  tokensOut: number,
): number | null {
  if (!model) return null;
  const keys = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model === key || model.startsWith(`${key}-`)) {
      const rate = MODEL_RATES[key]!;
      return (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
    }
  }
  return null;
}

export function formatUsd(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '$0.00';
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}
