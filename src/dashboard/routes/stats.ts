import type { FastifyPluginAsync } from 'fastify';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import { MODEL_RATES_VERSION, estimateUsd } from '../../agent/pricing.js';
import {
  bucketByTz,
  projectMonthlyUsd,
  type DailyBucket,
} from './_stats-shared.js';

export interface StatsDeps {
  sessions: SessionsRepo;
  /** IANA timezone from `config.service.timezone`. Used to bucket daily totals. */
  timezone: string;
}

interface StatsQuerystring {
  /** Window size for both the daily bars and the per-model aggregation.
   *  Clamped to [7, 60] server-side. Default 30. */
  days?: string;
}

export interface StatsResponse {
  /** Daily token totals over the last `days` days, tz-bucketed.
   *  Always length === days, sorted oldest → newest, zero-filled. */
  daily: DailyBucket[];
  /** Per-model token + session totals over the same window. */
  perModel: Array<{
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    sessions: number;
  }>;
  /** Aggregate for the last 7 days (across all models). */
  last7: { tokensIn: number; tokensOut: number; sessions: number };
  /** USD estimate for the whole `days` window (sum across per-model). */
  totalUsd: number;
  /** Monthly projection from the rolling-7-day cost × 30/7.
   *  `null` when history is <3 days. */
  monthlyProjectionUsd: number | null;
  /** Date (YYYY-MM-DD) the rates table was last checked — surface in UI. */
  ratesVersion: string;
  /** Echo of effective window, so the frontend can label the chart. */
  days: number;
}

export const statsRoutes =
  (deps: StatsDeps): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: StatsQuerystring }>('/api/stats', async (req) => {
      const raw = parseInt(req.query.days ?? '30', 10);
      const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 7), 60) : 30;
      const now = Date.now();
      const fromMs = now - days * 86_400_000;

      const rawRows = deps.sessions.dailyRaw(fromMs, now);
      const daily = bucketByTz(rawRows, deps.timezone, days, now);
      const perModel = deps.sessions.perModelTotals(fromMs);
      const last7 = deps.sessions.totalsBetween(now - 7 * 86_400_000, now);
      const last7PerModel = deps.sessions.perModelTotals(now - 7 * 86_400_000);

      // Window total USD (across full `days` window).
      const totalUsd = perModel.reduce(
        (acc, m) => acc + (estimateUsd(m.model, m.tokensIn, m.tokensOut) ?? 0),
        0,
      );
      // Rolling-7-day USD — computed per-model for pricing accuracy, then
      // projected to 30 days by `projectMonthlyUsd` (gated at ≥3 days of
      // history so a fresh install doesn't extrapolate).
      const last7Usd = last7PerModel.reduce(
        (acc, m) => acc + (estimateUsd(m.model, m.tokensIn, m.tokensOut) ?? 0),
        0,
      );
      const earliest = rawRows[0]?.started_at ?? null;
      const monthlyProjectionUsd = projectMonthlyUsd(last7Usd, earliest, now);

      const response: StatsResponse = {
        daily,
        perModel,
        last7,
        totalUsd,
        monthlyProjectionUsd,
        ratesVersion: MODEL_RATES_VERSION,
        days,
      };
      return response;
    });
  };
