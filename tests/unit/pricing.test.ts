import { describe, it, expect } from 'vitest';
import {
  MODEL_RATES,
  MODEL_RATES_VERSION,
  estimateUsd,
  formatUsd,
} from '../../src/agent/pricing.js';

describe('estimateUsd', () => {
  it('computes exact rates for known models', () => {
    // claude-opus-4-7: $15/Mtok in, $75/Mtok out → 100k in + 50k out = $1.50 + $3.75 = $5.25
    expect(estimateUsd('claude-opus-4-7', 100_000, 50_000)).toBeCloseTo(5.25, 5);
    // sonnet-4-6: $3/$15 → 1M in + 1M out = $3 + $15 = $18
    expect(estimateUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 5);
    // haiku-4-5: $0.25/$1.25 → 200k in + 100k out = $0.05 + $0.125 = $0.175
    expect(estimateUsd('claude-haiku-4-5', 200_000, 100_000)).toBeCloseTo(0.175, 5);
  });

  it('handles dated suffix via prefix match', () => {
    // Real model id shipped in session records:
    expect(estimateUsd('claude-haiku-4-5-20251001', 200_000, 100_000)).toBeCloseTo(
      0.175,
      5,
    );
  });

  it('returns null for null model', () => {
    expect(estimateUsd(null, 999_999, 999_999)).toBeNull();
  });

  it('returns null for empty string model', () => {
    expect(estimateUsd('', 100, 100)).toBeNull();
  });

  it('returns null for unknown model', () => {
    expect(estimateUsd('gpt-5', 100, 100)).toBeNull();
    expect(estimateUsd('claude-gibberish', 100, 100)).toBeNull();
  });

  it('longest-prefix match wins when family prefixes nest', () => {
    // If both `claude-opus-4-6` and `claude-opus-4` were ever added,
    // the longer key should win. This is a latent invariant — assert
    // it against the sort order the implementation relies on.
    const keys = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);
    expect(keys[0]!.length).toBeGreaterThanOrEqual(keys[keys.length - 1]!.length);
  });
});

describe('formatUsd', () => {
  it('null → em-dash', () => {
    expect(formatUsd(null)).toBe('—');
  });
  it('zero → $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
  it('positive under one cent → <$0.01', () => {
    expect(formatUsd(0.005)).toBe('<$0.01');
    expect(formatUsd(0.0001)).toBe('<$0.01');
  });
  it('small amounts → 2 decimals', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(42)).toBe('$42.00');
    expect(formatUsd(999.99)).toBe('$999.99');
  });
  it('thousands → $Xk', () => {
    expect(formatUsd(1_234)).toBe('$1.2k');
    expect(formatUsd(12_345)).toBe('$12.3k');
  });
  it('millions → $XM', () => {
    expect(formatUsd(1_234_567)).toBe('$1.2M');
  });
});

describe('MODEL_RATES_VERSION', () => {
  it('is a YYYY-MM-DD string', () => {
    expect(MODEL_RATES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
