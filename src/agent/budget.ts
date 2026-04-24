import type { SessionsRepo } from '../db/repositories/sessions.js';
import type { BudgetStateRepo } from '../db/repositories/budget-state.js';

export interface BudgetWindow {
  /** Inclusive lower bound (epoch ms). */
  fromMs: number;
  /** Exclusive upper bound (epoch ms). */
  toMs: number;
  /** Start of the CURRENT window in the local timezone (e.g. "2026-04-21 00:00 Europe/Zurich"). */
  windowLabel: string;
  /** When the current window flips (epoch ms). */
  nextResetMs: number;
  /** Manual reset anchor (ms) active for this window, or null if not set. */
  manualResetAt: number | null;
}

export interface BudgetStatus {
  window: BudgetWindow;
  dailyLimit: number;
  perSessionLimit: number;
  used: number;
  remaining: number;
  /** True iff `used >= dailyLimit`. */
  exhausted: boolean;
}

export interface BudgetConfigView {
  dailyTokenLimit: number;
  perSessionTokenLimit: number;
  /** "HH:MM" in service.timezone when the window resets. */
  dailyResetTime: string;
  /** IANA zone, e.g. "Europe/Zurich". */
  timezone: string;
}

export interface BudgetTracker {
  status(now?: number): BudgetStatus;
  /** True iff starting a new session is allowed (daily window has tokens remaining). */
  canStart(now?: number): boolean;
  /** Formats a reset message the bot can show the user verbatim. */
  exhaustedMessage(status?: BudgetStatus): string;
  /**
   * Zero the daily counter by anchoring the window start to "now". The
   * natural daily reset still fires at its configured time; this is a
   * manual-override for the principal (e.g. when they hit the soft cap
   * mid-day). Requires the tracker to have been built with a
   * `budgetState` repo; throws if not.
   *
   * Does NOT write an audit row or DM the principal — callers are
   * expected to do both so they can tag the audit with their own
   * `actor` string (cli / tg:chatId / dashboard).
   */
  resetNow(now?: number): { before: BudgetStatus; after: BudgetStatus };
}

export function createBudgetTracker(
  repo: SessionsRepo,
  cfg: () => BudgetConfigView,
  /**
   * Optional — when provided, the tracker honors a manual "reset anchor"
   * stored in `budget_state`. If the anchor is newer than the natural
   * window start but older than the next natural reset, it becomes the
   * effective window start. Nothing else changes: the natural reset
   * still fires at its normal time and implicitly retires the anchor.
   *
   * Tests that don't care about the override path can pass `null`.
   */
  budgetState: BudgetStateRepo | null = null,
): BudgetTracker {
  function status(now = Date.now()): BudgetStatus {
    const c = cfg();
    const natural = currentWindow(now, c.dailyResetTime, c.timezone);
    const anchor = budgetState?.getResetAnchor() ?? null;

    // Anchor only bites when it's INSIDE the current natural window.
    // Older anchors are stale (the natural reset already happened);
    // future anchors shouldn't exist but would be ignored safely.
    const effectiveFromMs =
      anchor !== null && anchor > natural.fromMs && anchor < natural.toMs
        ? anchor
        : natural.fromMs;
    const manualResetAt = effectiveFromMs === natural.fromMs ? null : anchor;

    const window: BudgetWindow = {
      ...natural,
      fromMs: effectiveFromMs,
      manualResetAt,
    };
    const used = repo.tokensUsedBetween(window.fromMs, window.toMs);
    const remaining = Math.max(0, c.dailyTokenLimit - used);
    return {
      window,
      dailyLimit: c.dailyTokenLimit,
      perSessionLimit: c.perSessionTokenLimit,
      used,
      remaining,
      exhausted: used >= c.dailyTokenLimit,
    };
  }

  function canStart(now?: number) {
    return !status(now).exhausted;
  }

  function exhaustedMessage(s?: BudgetStatus): string {
    const st = s ?? status();
    const reset = new Date(st.window.nextResetMs).toLocaleString('en-GB', {
      timeZone: cfg().timezone,
      hour12: false,
    });
    return `⛔ Daily token budget exhausted (${st.used.toLocaleString()} / ${st.dailyLimit.toLocaleString()} tokens). Window resets at ${reset} (${cfg().timezone}).`;
  }

  function resetNow(now = Date.now()): { before: BudgetStatus; after: BudgetStatus } {
    if (!budgetState) {
      throw new Error(
        'BudgetTracker.resetNow() requires a budgetState repo — tracker was constructed with null',
      );
    }
    const before = status(now);
    budgetState.setResetAnchor(now);
    const after = status(now);
    return { before, after };
  }

  return { status, canStart, exhaustedMessage, resetNow };
}

/**
 * Compute the [fromMs, toMs) window for the DAY that `now` belongs to, where
 * a day starts at `HH:MM` in `timezone`. Pure function so it is trivially
 * testable across DST boundaries.
 *
 * Strategy: format `now` in the target timezone into y-m-d-h-m components,
 * compute the start-of-day for the target TZ as an offset from the formatted
 * values, then round-trip via UTC. We rely on `Intl.DateTimeFormat` being
 * available (it is, in Node ≥ 13 with full-icu — the default since Node 18).
 */
export function currentWindow(
  now: number,
  dailyResetTime: string,
  timezone: string,
): BudgetWindow {
  const [hStr, mStr] = dailyResetTime.split(':');
  const resetH = Number(hStr);
  const resetM = Number(mStr);
  if (!Number.isFinite(resetH) || !Number.isFinite(resetM)) {
    throw new Error(`invalid dailyResetTime: ${dailyResetTime}`);
  }

  const parts = zoneParts(now, timezone);

  // "today" in the target TZ, at HH:MM = reset time.
  const candidate = zoneToEpoch(
    { y: parts.y, m: parts.m, d: parts.d, h: resetH, min: resetM },
    timezone,
  );

  // If `now` is BEFORE today's reset (e.g. reset=03:00 and now=01:30), the
  // current window actually started yesterday.
  let fromMs: number;
  let toMs: number;
  if (now < candidate) {
    fromMs = addOneDay(candidate, timezone, -1);
    toMs = candidate;
  } else {
    fromMs = candidate;
    toMs = addOneDay(candidate, timezone, +1);
  }

  const windowLabel = new Date(fromMs).toLocaleString('en-CA', {
    timeZone: timezone,
    hour12: false,
  });

  return { fromMs, toMs, windowLabel, nextResetMs: toMs, manualResetAt: null };
}

interface ZoneParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function zoneParts(epochMs: number, timezone: string): ZoneParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour === '24' ? '0' : parts.hour),
    min: Number(parts.minute),
    s: Number(parts.second ?? 0),
  };
}

/**
 * Convert (y-m-d h:min in `timezone`) → epoch ms. Uses a two-step offset
 * correction so we don't misread on DST days.
 */
function zoneToEpoch(
  parts: { y: number; m: number; d: number; h: number; min: number },
  timezone: string,
): number {
  const naiveUtc = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.min, 0);
  const offset1 = timezoneOffsetMs(naiveUtc, timezone);
  const firstGuess = naiveUtc - offset1;
  const offset2 = timezoneOffsetMs(firstGuess, timezone);
  return naiveUtc - offset2;
}

function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const p = zoneParts(utcMs, timezone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - utcMs;
}

function addOneDay(utcMs: number, timezone: string, direction: 1 | -1): number {
  const p = zoneParts(utcMs, timezone);
  const nextDay = new Date(Date.UTC(p.y, p.m - 1, p.d + direction)).getUTCDate();
  const nextMonth = new Date(Date.UTC(p.y, p.m - 1, p.d + direction)).getUTCMonth() + 1;
  const nextYear = new Date(Date.UTC(p.y, p.m - 1, p.d + direction)).getUTCFullYear();
  return zoneToEpoch({ y: nextYear, m: nextMonth, d: nextDay, h: p.h, min: p.min }, timezone);
}
