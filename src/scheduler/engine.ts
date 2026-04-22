import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { Api } from 'grammy';
import type { SchedulesRepo, ScheduleRecord } from '../db/repositories/schedules.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { SessionsRepo } from '../db/repositories/sessions.js';
import type { QueueManager } from '../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../agent/session.js';
import type { BudgetTracker } from '../agent/budget.js';
import { parsePayload } from './payloads.js';
import type { ScheduleKind } from './payloads.js';
import type { Handler, HandlerContext, HandlerResult, AgentTaskSubmitInput } from './handlers/types.js';
import { bashHandler } from './handlers/bash.js';
import { httpCheckHandler } from './handlers/http-check.js';
import { agentTaskHandler } from './handlers/agent-task.js';
import { reminderHandler } from './handlers/reminder.js';
import { createSchedulerTelegramSink } from './telegram-output.js';

export interface SchedulerEngineDeps {
  logger: Logger;
  telegramApi: Api;
  schedulesRepo: SchedulesRepo;
  sessionsRepo: SessionsRepo;
  audit: AuditRepo;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult>;
  budget: BudgetTracker;
  /** Builds a SessionExecuteInput template for a scheduler-triggered session. */
  buildSchedulerSessionInput: (args: {
    sessionId: string;
    chatId: string;
    userMessage: string;
    scheduleName: string;
    modelOverride?: string;
    signal: AbortSignal;
  }) => SessionExecuteInput;
  /** Principal user id for default chat id resolution. */
  principalChatId: number | null;
  timezone: string;
  /** Optional override for tests. */
  nodeCron?: typeof cron;
  /** Alert the principal on auto-disable / budget hit. */
  notifyPrincipal: (text: string) => Promise<void>;
}

export interface SchedulerEngine {
  refresh(): void;
  stop(): void;
  runNow(scheduleId: number): Promise<HandlerResult>;
  handlerFor(kind: ScheduleKind): Handler<unknown> | undefined;
}

const LOOP_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOOP_RATE_MAX_RUNS = 5;
const LOOP_FAIL_THRESHOLD = 3;

export function createSchedulerEngine(deps: SchedulerEngineDeps): SchedulerEngine {
  const handlers: Record<ScheduleKind, Handler<unknown>> = {
    bash: bashHandler as unknown as Handler<unknown>,
    'http-check': httpCheckHandler as unknown as Handler<unknown>,
    'agent-task': agentTaskHandler as unknown as Handler<unknown>,
    reminder: reminderHandler as unknown as Handler<unknown>,
  };

  /** Track live cron tasks keyed by schedule id for diffing on refresh(). */
  const tasks = new Map<number, { task: ScheduledTask; cronExpr: string }>();

  const cronLib = deps.nodeCron ?? cron;

  function buildHandlerContext(schedule: ScheduleRecord): HandlerContext {
    return {
      schedule,
      logger: deps.logger.child({ schedule: schedule.name }),
      telegramApi: deps.telegramApi,
      defaultChatId: deps.principalChatId,
      queue: deps.queue,
      submitAgentTask: (args) => submitAgentTask(args, schedule),
    };
  }

  async function submitAgentTask(
    args: AgentTaskSubmitInput,
    _schedule: ScheduleRecord,
  ): Promise<SessionExecuteResult> {
    const sessionId = randomUUID();
    const controller = new AbortController();

    const sink = createSchedulerTelegramSink({
      api: deps.telegramApi,
      chatId: Number(args.chatId),
      scheduleName: args.scheduleName,
      logger: deps.logger,
    });

    const base = deps.buildSchedulerSessionInput({
      sessionId,
      chatId: args.chatId,
      userMessage: args.prompt,
      scheduleName: args.scheduleName,
      ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
      signal: controller.signal,
    });

    const req: SessionExecuteInput = { ...base, sink };
    const result = await deps.queue.submit(args.chatId, req);
    return result;
  }

  async function fire(schedule: ScheduleRecord): Promise<void> {
    const startedAt = Date.now();
    // Per-schedule daily budget reset (independent of global budget window —
    // we use the same "today in service timezone" anchor).
    const todayWindowStart = startOfTodayMs(deps.timezone);
    deps.schedulesRepo.resetBudgetIfStale(schedule.id, todayWindowStart);

    // Reload the schedule (post-reset fields may have changed).
    const fresh = deps.schedulesRepo.get(schedule.id);
    if (!fresh || fresh.enabled !== 1) return;

    // Loop-rate protection: > N runs in the last window → auto-disable.
    const recentCount = deps.schedulesRepo.countRunsSince(
      fresh.id,
      Date.now() - LOOP_RATE_WINDOW_MS,
    );
    if (recentCount > LOOP_RATE_MAX_RUNS) {
      deps.logger.error(
        { schedule: fresh.name, recentCount },
        `schedule "${fresh.name}" exceeded loop-rate cap — auto-disabling`,
      );
      autoDisable(fresh, `loop-rate: ${recentCount} runs in ${LOOP_RATE_WINDOW_MS / 60000}min`);
      return;
    }

    // Per-schedule budget (tokens/day) check up-front for kinds that spend.
    if (fresh.budget_tokens_per_day !== null) {
      if (fresh.budget_used_today >= fresh.budget_tokens_per_day) {
        deps.logger.warn(
          {
            schedule: fresh.name,
            used: fresh.budget_used_today,
            cap: fresh.budget_tokens_per_day,
          },
          'schedule per-day budget exhausted — skipping',
        );
        deps.schedulesRepo.recordRun({
          schedule_id: fresh.id,
          started_at: startedAt,
          ended_at: Date.now(),
          status: 'skipped',
          output: 'per-schedule token budget exhausted',
          tokens_used: 0,
        });
        return;
      }
    }

    // Global daily budget: refuse to spawn if it's exhausted (only matters
    // for kinds that could spend).
    if ((fresh.kind === 'agent-task' || fresh.kind === 'bash' || fresh.kind === 'http-check') && !deps.budget.canStart()) {
      deps.schedulesRepo.recordRun({
        schedule_id: fresh.id,
        started_at: startedAt,
        ended_at: Date.now(),
        status: 'skipped',
        output: 'global daily token budget exhausted',
        tokens_used: 0,
      });
      return;
    }

    let result: HandlerResult;
    try {
      const handler = handlers[fresh.kind];
      if (!handler) {
        result = { status: 'fail', error: `unknown kind: ${fresh.kind}` };
      } else {
        const payload = parsePayload(fresh.kind, fresh.payload);
        result = await handler.run(payload, buildHandlerContext(fresh));
      }
    } catch (e) {
      result = { status: 'fail', error: (e as Error).message };
    }

    const endedAt = Date.now();
    deps.schedulesRepo.recordRun({
      schedule_id: fresh.id,
      started_at: startedAt,
      ended_at: endedAt,
      status: result.status,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error ? { output: result.error } : {}),
      tokens_used: result.tokensUsed ?? 0,
    });

    if (result.tokensUsed && result.tokensUsed > 0) {
      deps.schedulesRepo.incrementBudget(fresh.id, result.tokensUsed);
    }
    deps.schedulesRepo.update(fresh.id, { last_run: endedAt });

    // Consecutive-fail tracking for loop protection.
    if (result.status === 'fail') {
      const next = fresh.consecutive_fails + 1;
      deps.schedulesRepo.update(fresh.id, { consecutive_fails: next });
      if (next >= LOOP_FAIL_THRESHOLD) {
        autoDisable(fresh, `${next} consecutive failures`);
      }
    } else if (result.status === 'success') {
      if (fresh.consecutive_fails > 0) {
        deps.schedulesRepo.update(fresh.id, { consecutive_fails: 0 });
      }
    }

    // After a spending run: check if we've newly busted the budget → alert.
    if (
      result.tokensUsed &&
      result.tokensUsed > 0 &&
      fresh.budget_tokens_per_day !== null
    ) {
      const nowUsed = fresh.budget_used_today + result.tokensUsed;
      if (nowUsed >= fresh.budget_tokens_per_day) {
        deps.audit.record({
          kind: 'schedule_budget_exhausted',
          actor: 'scheduler',
          detail: {
            scheduleId: fresh.id,
            name: fresh.name,
            used: nowUsed,
            cap: fresh.budget_tokens_per_day,
          },
        });
        deps.notifyPrincipal(
          `⚠️ Schedule \`${fresh.name}\` hit its per-day token budget (${nowUsed}/${fresh.budget_tokens_per_day}). Further runs today will be skipped until reset.`,
        ).catch(() => {
          /* best-effort */
        });
      }
    }

    // One-shot schedules (reminders, "run this once at 15:30") self-destruct
    // after firing — regardless of success/fail — so they can't fire again.
    // We stop the node-cron task and delete the row; audit records the
    // outcome so the run is still inspectable in the dashboard's audit view.
    if (fresh.recurring === 0) {
      stopTask(fresh.id);
      deps.schedulesRepo.remove(fresh.id);
      deps.audit.record({
        kind: 'schedule_one_shot_completed',
        actor: 'scheduler',
        detail: {
          scheduleId: fresh.id,
          name: fresh.name,
          status: result.status,
          cron: fresh.cron_expr,
        },
      });
    }
  }

  function autoDisable(schedule: ScheduleRecord, reason: string): void {
    deps.schedulesRepo.update(schedule.id, { enabled: false });
    deps.audit.record({
      kind: 'schedule_auto_disabled',
      actor: 'scheduler',
      detail: { scheduleId: schedule.id, name: schedule.name, reason },
    });
    stopTask(schedule.id);
    deps.notifyPrincipal(
      `⚠️ Schedule \`${schedule.name}\` auto-disabled: ${reason}. Re-enable via \`andybioticlaw schedule enable ${schedule.id}\` once fixed.`,
    ).catch(() => {
      /* best-effort */
    });
  }

  function stopTask(id: number): void {
    const existing = tasks.get(id);
    if (existing) {
      try {
        existing.task.stop();
      } catch {
        /* ignore */
      }
      tasks.delete(id);
    }
  }

  function startOrReplaceTask(schedule: ScheduleRecord): void {
    const existing = tasks.get(schedule.id);
    if (existing && existing.cronExpr === schedule.cron_expr) return;
    if (existing) stopTask(schedule.id);
    if (!cronLib.validate(schedule.cron_expr)) {
      deps.logger.error(
        { schedule: schedule.name, cron: schedule.cron_expr },
        'invalid cron expression — skipping schedule',
      );
      return;
    }
    const task = cronLib.schedule(
      schedule.cron_expr,
      () => {
        void fire(schedule);
      },
      { timezone: deps.timezone },
    );
    tasks.set(schedule.id, { task, cronExpr: schedule.cron_expr });
    deps.logger.debug(
      { schedule: schedule.name, cron: schedule.cron_expr },
      'schedule registered',
    );
  }

  function refresh(): void {
    const all = deps.schedulesRepo.list();
    const dbIds = new Set(all.filter((s) => s.enabled === 1).map((s) => s.id));
    // Remove tasks for schedules that disappeared or were disabled.
    for (const id of Array.from(tasks.keys())) {
      if (!dbIds.has(id)) stopTask(id);
    }
    // Add / update tasks from DB state.
    for (const s of all) {
      if (s.enabled === 1) startOrReplaceTask(s);
      else stopTask(s.id);
    }
    deps.logger.info({ count: dbIds.size }, 'scheduler refreshed');
  }

  function stop(): void {
    for (const id of Array.from(tasks.keys())) stopTask(id);
  }

  async function runNow(scheduleId: number): Promise<HandlerResult> {
    const schedule = deps.schedulesRepo.get(scheduleId);
    if (!schedule) throw new Error(`no schedule with id ${scheduleId}`);
    const startedAt = Date.now();
    try {
      const payload = parsePayload(schedule.kind, schedule.payload);
      const handler = handlers[schedule.kind];
      if (!handler) throw new Error(`unknown kind: ${schedule.kind}`);
      const out = await handler.run(payload, buildHandlerContext(schedule));
      deps.schedulesRepo.recordRun({
        schedule_id: schedule.id,
        started_at: startedAt,
        ended_at: Date.now(),
        status: out.status,
        ...(out.output !== undefined ? { output: out.output } : {}),
        ...(out.error ? { output: out.error } : {}),
        tokens_used: out.tokensUsed ?? 0,
      });
      deps.schedulesRepo.update(schedule.id, { last_run: Date.now() });
      if (out.tokensUsed) deps.schedulesRepo.incrementBudget(schedule.id, out.tokensUsed);
      return out;
    } catch (e) {
      const result: HandlerResult = { status: 'fail', error: (e as Error).message };
      deps.schedulesRepo.recordRun({
        schedule_id: scheduleId,
        started_at: startedAt,
        ended_at: Date.now(),
        status: 'fail',
        output: result.error ?? '',
        tokens_used: 0,
      });
      return result;
    }
  }

  return {
    refresh,
    stop,
    runNow,
    handlerFor: (kind: ScheduleKind) => handlers[kind],
  };
}

/**
 * Start of "today" in the given IANA timezone, expressed as epoch ms. Used
 * for the per-schedule budget window (same anchor as the global budget,
 * with fixed 00:00 reset).
 */
function startOfTodayMs(timezone: string): number {
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
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  // Midnight LOCAL in timezone → UTC epoch via two-step offset correction.
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = timezoneOffset(naiveUtc, timezone);
  return naiveUtc - offset;
}

function timezoneOffset(utcMs: number, timezone: string): number {
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
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === '24' ? '0' : p.hour),
    Number(p.minute),
    Number(p.second ?? 0),
  );
  return asUtc - utcMs;
}
