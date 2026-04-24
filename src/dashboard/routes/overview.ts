import type { FastifyPluginAsync } from 'fastify';
import type { SessionsRepo } from '../../db/repositories/sessions.js';
import type { HeartbeatsRepo } from '../../db/repositories/heartbeats.js';
import type { BudgetTracker } from '../../agent/budget.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { SchedulesRepo } from '../../db/repositories/schedules.js';
import type { QueueManager } from '../../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../../agent/session.js';
import type { RateLimitTracker } from '../../agent/rate-limit-tracker.js';
import type { BotProfile } from '../../telegram/bot.js';
import type { AuthMethod } from '../../agent/credentials.js';
import { bucketByTz, projectMonthlyUsd } from './_stats-shared.js';
import { estimateUsd } from '../../agent/pricing.js';

export interface OverviewDeps {
  sessions: SessionsRepo;
  heartbeats: HeartbeatsRepo;
  budget: BudgetTracker;
  skills: SkillRegistry;
  schedules: SchedulesRepo;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult> | null;
  credentialsOk: () => boolean;
  authMethod: () => AuthMethod | null;
  agentName: string;
  model: string;
  timezone: string;
  rateLimitTracker: RateLimitTracker;
  principalUserId: number | null;
  botProfile: () => BotProfile | null;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export const overviewRoutes =
  (deps: OverviewDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/overview', async () => {
      const recent = deps.sessions.list({ limit: 5 });
      const failed = deps.sessions.list({ status: 'failed', limit: 3 });
      const budgetStatus = deps.budget.status();
      const rl = deps.rateLimitTracker.latest();

      // Local 5-hour rolling token estimate — sums our own recorded
      // tokens_input + tokens_output for sessions started in the last 5h.
      // This is NOT a direct analogue of Anthropic's subscription meter
      // (their meter treats cache-reads specially and counts usage ACROSS
      // this service plus anything else you do in Claude Code), but it's
      // a useful sanity floor when the CLI hasn't reported a snapshot yet.
      const rollingFiveHourTokens = deps.sessions.tokensUsedSince(
        Date.now() - FIVE_HOURS_MS,
      );

      // Teaser stats for the Overview sparkline + monthly-spend estimate.
      // Larger drill-down lives under /stats.
      const now = Date.now();
      const last14Raw = deps.sessions.dailyRaw(now - 14 * 86_400_000, now);
      const last14Buckets = bucketByTz(last14Raw, deps.timezone, 14, now);
      const last14DailyTokens = last14Buckets.map((b) => b.tokens);

      // Per-model last-7-day costs → monthly projection. Using perModelTotals
      // rather than summing dailyRaw is both cheaper (pre-aggregated in SQL)
      // and more accurate (preserves the input/output split for pricing).
      const last7PerModel = deps.sessions.perModelTotals(now - 7 * 86_400_000);
      const last7Usd = last7PerModel.reduce((acc, row) => {
        const usd = estimateUsd(row.model, row.tokensIn, row.tokensOut);
        return acc + (usd ?? 0);
      }, 0);
      // Earliest session — null when the sessions table is empty → projection is null.
      const earliest = last14Raw[0]?.started_at ?? null;
      const monthlyProjectionUsd = projectMonthlyUsd(last7Usd, earliest, now);

      const bp = deps.botProfile();
      return {
        agentName: deps.agentName,
        model: deps.model,
        timezone: deps.timezone,
        principalUserId: deps.principalUserId,
        bot: {
          username: bp?.username ?? null,
          firstName: bp?.firstName ?? null,
          hasAvatar: bp?.avatar != null,
        },
        credentialsOk: deps.credentialsOk(),
        authMethod: deps.authMethod(),
        budget: {
          used: budgetStatus.used,
          limit: budgetStatus.dailyLimit,
          remaining: budgetStatus.remaining,
          exhausted: budgetStatus.exhausted,
          nextResetMs: budgetStatus.window.nextResetMs,
        },
        rateLimit: {
          /** Latest CLI-reported rate-limit snapshot, or `null` if we haven't seen one yet. */
          latest: rl,
          /** Our own rolling 5h token sum — independent of the CLI report. */
          localRollingFiveHourTokens: rollingFiveHourTokens,
        },
        queueDepths: deps.queue?.depths() ?? {},
        queueTotalDepth: deps.queue?.totalDepth() ?? 0,
        latestHeartbeat: deps.heartbeats.latest(),
        skills: {
          total: deps.skills.list().length,
          enabled: deps.skills.list().filter((s) => s.enabled).length,
        },
        schedules: {
          total: deps.schedules.list().length,
          enabled: deps.schedules.list({ enabledOnly: true }).length,
        },
        recentSessions: recent,
        recentFailures: failed,
        last14DailyTokens,
        monthlyProjectionUsd,
      };
    });
  };
