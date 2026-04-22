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

export interface OverviewDeps {
  sessions: SessionsRepo;
  heartbeats: HeartbeatsRepo;
  budget: BudgetTracker;
  skills: SkillRegistry;
  schedules: SchedulesRepo;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult> | null;
  credentialsOk: () => boolean;
  agentName: string;
  model: string;
  timezone: string;
}

export const overviewRoutes =
  (deps: OverviewDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/overview', async () => {
      const recent = deps.sessions.list({ limit: 5 });
      const failed = deps.sessions.list({ status: 'failed', limit: 3 });
      const budgetStatus = deps.budget.status();
      return {
        agentName: deps.agentName,
        model: deps.model,
        timezone: deps.timezone,
        credentialsOk: deps.credentialsOk(),
        budget: {
          used: budgetStatus.used,
          limit: budgetStatus.dailyLimit,
          remaining: budgetStatus.remaining,
          exhausted: budgetStatus.exhausted,
          nextResetMs: budgetStatus.window.nextResetMs,
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
      };
    });
  };
