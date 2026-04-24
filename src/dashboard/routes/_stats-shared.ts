import type { DailyRawRow } from '../../db/repositories/sessions.js';

export interface DailyBucket {
  /** `YYYY-MM-DD` in the operator's configured timezone. */
  date: string;
  tokens: number;
}

/**
 * Bucket raw session rows by day in the operator's IANA timezone, filling
 * empty days with `tokens: 0` so bar charts have a contiguous axis.
 *
 * Why JS-side instead of SQL: SQLite's `DATE(epoch, 'unixepoch', 'localtime')`
 * modifier uses the server-process tz, not the operator's `service.timezone`
 * config. Doing the bucketing in JS with `Intl.DateTimeFormat` gives us the
 * correct day boundaries for any IANA zone on any server. ~200 sessions/day
 * × 30 days is trivial data volume.
 */
export function bucketByTz(
  rows: DailyRawRow[],
  timezone: string,
  days: number,
  now: number = Date.now(),
): DailyBucket[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // `en-CA` locale → `YYYY-MM-DD` ordering via `formatToParts`-free call.

  // Seed buckets with every day in the window so empty days show as 0.
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 86_400_000);
    buckets.set(fmt.format(date), 0);
  }

  // Aggregate tokens into their tz-local day bucket. Sessions outside the
  // window are ignored (shouldn't exist if the caller passed `fromMs`
  // correctly, but be defensive).
  for (const row of rows) {
    const key = fmt.format(new Date(row.started_at));
    if (buckets.has(key)) {
      buckets.set(key, buckets.get(key)! + row.tokens);
    }
  }

  return Array.from(buckets.entries()).map(([date, tokens]) => ({
    date,
    tokens,
  }));
}

/**
 * Project a monthly equivalent from a 7-day rolling total. Gated at ≥3
 * days of *observed* data — otherwise return `null` (rendered as `'—'`)
 * to avoid extrapolating wild numbers from a brand-new install.
 *
 * The "observed" check looks at whether any session started ≥`minDays`
 * days ago; if the DB is younger than that, we don't have a real baseline.
 */
export function projectMonthlyUsd(
  last7DayUsd: number,
  earliestSessionMs: number | null,
  now: number = Date.now(),
): number | null {
  const MIN_DAYS = 3;
  if (earliestSessionMs === null) return null;
  const ageDays = (now - earliestSessionMs) / 86_400_000;
  if (ageDays < MIN_DAYS) return null;
  // Extrapolate: 7-day total × (30/7) = 30-day equivalent.
  return (last7DayUsd * 30) / 7;
}
