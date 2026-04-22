import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { MemoryManager } from './manager.js';
import type { MemoryRepo } from '../db/repositories/memory.js';
import type { SessionsRepo } from '../db/repositories/sessions.js';
import { sweepSessionWorkspaces } from '../observability/workspace-cleanup.js';

export interface MemoryTtlCronDeps {
  manager: MemoryManager;
  repo: MemoryRepo;
  sessionsRepo: SessionsRepo;
  logger: Logger;
  /** Cron expression, e.g. "0 3 * * *". Read from config.memory.ttlCleanupCron. */
  cronExpr: () => string;
  /** Service timezone. */
  timezone: string;
  /** ms after which a still-pending proposal is marked expired. Default 7d. */
  proposalMaxAgeMs?: number;
  /** Root of per-session workspace dirs (one per session UUID). */
  sessionWorkspaceRoot: string;
}

export interface MemoryTtlCron {
  start(): void;
  stop(): void;
  runNow(): {
    memoryRemoved: number;
    proposalsExpired: number;
    workspacesRemoved: number;
  };
}

const DEFAULT_PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createMemoryTtlCron(deps: MemoryTtlCronDeps): MemoryTtlCron {
  let task: ScheduledTask | null = null;

  function runNow() {
    const memoryRemoved = deps.manager.runTtlCleanup();
    const cutoff = Date.now() - (deps.proposalMaxAgeMs ?? DEFAULT_PROPOSAL_MAX_AGE_MS);
    const proposalsExpired = deps.repo.proposalMarkExpired(cutoff);
    const workspaceSweep = sweepSessionWorkspaces({
      logger: deps.logger,
      sessionsRepo: deps.sessionsRepo,
      workspaceRoot: deps.sessionWorkspaceRoot,
    });
    const workspacesRemoved = workspaceSweep.removed;
    if (memoryRemoved > 0 || proposalsExpired > 0 || workspacesRemoved > 0) {
      deps.logger.info(
        { memoryRemoved, proposalsExpired, workspacesRemoved },
        'nightly cleanup ran',
      );
    }
    return { memoryRemoved, proposalsExpired, workspacesRemoved };
  }

  return {
    start() {
      if (task) return;
      const expr = deps.cronExpr();
      if (!cron.validate(expr)) {
        deps.logger.error({ expr }, 'invalid memory.ttlCleanupCron — TTL cleanup disabled');
        return;
      }
      task = cron.schedule(
        expr,
        () => {
          try {
            runNow();
          } catch (e) {
            deps.logger.warn(
              { err: (e as Error).message },
              'memory TTL cleanup tick failed',
            );
          }
        },
        { timezone: deps.timezone },
      );
      deps.logger.debug({ expr, timezone: deps.timezone }, 'memory TTL cron scheduled');
    },
    stop() {
      if (task) {
        task.stop();
        task = null;
      }
    },
    runNow,
  };
}
