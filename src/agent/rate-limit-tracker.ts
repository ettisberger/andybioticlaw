/**
 * Captures the most recent `rate_limit_event` payload Anthropic's Claude CLI
 * emits during a session. This is the source of truth for the user's 5-hour
 * subscription window status — independent from our own local daily budget.
 *
 * The payload shape is fragile (varies by CLI version). We store it as-is
 * (opaque `unknown`) plus a couple of strongly-typed fields we know about,
 * so the dashboard renders something useful even if Anthropic changes the
 * less-stable fields.
 */
export interface RateLimitSnapshot {
  /** Epoch ms when we saw this payload. */
  observedAt: number;
  /** "allowed" | "limited" | other — best-effort from payload. */
  status: string | null;
  /** "five_hour" | other. */
  rateLimitType: string | null;
  /** When the rate-limit window resets. Epoch seconds in Anthropic's payload. */
  resetsAtSec: number | null;
  /** "allowed" | "rejected" — overage (pay-per-use on top of subscription). */
  overageStatus: string | null;
  /** Typically "org_level_disabled" when you've disabled overage on your account. */
  overageDisabledReason: string | null;
  /** True when the current turn is eating overage, not subscription quota. */
  isUsingOverage: boolean | null;
  /** Full raw payload — keeps dashboard resilient to schema drift. */
  raw: unknown;
}

export interface RateLimitTracker {
  record(payload: unknown): void;
  latest(): RateLimitSnapshot | null;
}

export function createRateLimitTracker(): RateLimitTracker {
  let snapshot: RateLimitSnapshot | null = null;

  return {
    record(payload: unknown) {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as Record<string, unknown>;
      snapshot = {
        observedAt: Date.now(),
        status: asString(p.status),
        rateLimitType: asString(p.rateLimitType),
        resetsAtSec: asNumber(p.resetsAt),
        overageStatus: asString(p.overageStatus),
        overageDisabledReason: asString(p.overageDisabledReason),
        isUsingOverage: asBool(p.isUsingOverage),
        raw: payload,
      };
    },
    latest() {
      return snapshot;
    },
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
