import type { Logger } from 'pino';
import type { Api } from 'grammy';
import type { ScheduleRecord } from '../../db/repositories/schedules.js';
import type { QueueManager } from '../../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../../agent/session.js';

export interface HandlerContext {
  schedule: ScheduleRecord;
  logger: Logger;
  /** Send a plain Telegram message (reminders, chained output). */
  telegramApi: Api;
  /** Default chat id if the payload doesn't specify one (principal). */
  defaultChatId: number | null;
  /** Submit an agent-task to the per-chat queue. Used by agent-task and by
   * bash/http-check chaining on a trigger envelope. Returns the final
   * session result so we can capture tokens_used. */
  submitAgentTask: (
    input: AgentTaskSubmitInput,
  ) => Promise<SessionExecuteResult>;
  /** Queue for depth introspection (Phase 5 dashboard). */
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult>;
}

export interface AgentTaskSubmitInput {
  chatId: string;
  prompt: string;
  scheduleName: string;
  modelOverride?: string;
  budgetRemainingTokens?: number | null;
}

export interface HandlerResult {
  status: 'success' | 'fail' | 'skipped';
  output?: string;
  tokensUsed?: number;
  error?: string;
}

export interface Handler<Payload> {
  kind: string;
  run(payload: Payload, ctx: HandlerContext): Promise<HandlerResult>;
}
