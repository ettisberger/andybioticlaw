import { z } from 'zod';

/**
 * Zod schemas for each schedule kind's `payload` JSON. We store payloads as
 * a JSON string in `schedules.payload` and parse+validate on every load.
 */

export const BashPayload = z.object({
  command: z.string().min(1),
  timeoutSec: z.number().int().min(1).max(600).default(30),
  /** Working dir for the command. Defaults to data/workspaces/schedule-bash/. */
  cwd: z.string().optional(),
});
export type BashPayload = z.infer<typeof BashPayload>;

export const HttpCheckPayload = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'HEAD']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  timeoutSec: z.number().int().min(1).max(120).default(15),
  /** If set, schedule run fails when the response status doesn't match. */
  expectedStatus: z.number().int().min(100).max(599).optional(),
});
export type HttpCheckPayload = z.infer<typeof HttpCheckPayload>;

export const AgentTaskPayload = z.object({
  prompt: z.string().min(1),
  /**
   * Telegram chat to stream/send the response to. If omitted, the scheduler
   * uses the principal user (first entry in telegram.dm.allowedUserIds).
   */
  chatId: z.string().optional(),
  /** Override for agent.model. Rarely needed. */
  model: z.string().optional(),
});
export type AgentTaskPayload = z.infer<typeof AgentTaskPayload>;

export const ReminderPayload = z.object({
  text: z.string().min(1).max(4000),
  chatId: z.string().optional(),
});
export type ReminderPayload = z.infer<typeof ReminderPayload>;

/**
 * Shape emitted to stdout (for `bash`) or the response body (for `http-check`)
 * to trigger a downstream agent-task. If the handler sees this structure in
 * the output it fires an agent session with `prompt` and optional `chatId`.
 *
 *     {"trigger": true, "prompt": "Summarize the attached log."}
 *
 * Any other stdout is treated as informational — no agent session spawned.
 */
export const TriggerEnvelope = z.object({
  trigger: z.literal(true),
  prompt: z.string().min(1),
  chatId: z.string().optional(),
});
export type TriggerEnvelope = z.infer<typeof TriggerEnvelope>;

export const ScheduleKind = z.enum(['bash', 'http-check', 'agent-task', 'reminder']);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

const kindToSchema = {
  bash: BashPayload,
  'http-check': HttpCheckPayload,
  'agent-task': AgentTaskPayload,
  reminder: ReminderPayload,
} as const;

export type PayloadForKind = {
  bash: BashPayload;
  'http-check': HttpCheckPayload;
  'agent-task': AgentTaskPayload;
  reminder: ReminderPayload;
};

export class SchedulePayloadError extends Error {
  readonly issues: string[];
  constructor(kind: string, issues: string[]) {
    super(`invalid payload for kind ${kind}: ${issues.join('; ')}`);
    this.name = 'SchedulePayloadError';
    this.issues = issues;
  }
}

export function parsePayload<K extends ScheduleKind>(
  kind: K,
  rawJson: string,
): PayloadForKind[K] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new SchedulePayloadError(kind, [`not valid JSON: ${(e as Error).message}`]);
  }
  const schema = kindToSchema[kind];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SchedulePayloadError(
      kind,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data as PayloadForKind[K];
}

/**
 * Try to extract a trigger envelope from a stdout/response body. Returns null
 * if the body is not JSON or doesn't match the envelope shape.
 */
export function parseTrigger(body: string): TriggerEnvelope | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const result = TriggerEnvelope.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
