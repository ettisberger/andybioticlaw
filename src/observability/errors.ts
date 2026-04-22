import type { Logger } from 'pino';
import type { AppEventBus } from '../events/bus.js';

export interface ErrorReportInput {
  kind: string;
  message: string;
  context?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Central error bus. Callers use `report()` to surface non-fatal errors. In
 * Phase 1 this just logs and emits `error:reported` on the event bus. Phase 2
 * wires a listener that forwards to Telegram when `observability.errorsToTelegram`
 * is true (and to the `errorChatIdOverride` chat if set).
 */
export interface ErrorReporter {
  report(err: ErrorReportInput): void;
}

export function createErrorReporter(bus: AppEventBus, logger: Logger): ErrorReporter {
  return {
    report({ kind, message, context, cause }) {
      logger.error({ kind, ctx: context, cause: cause instanceof Error ? cause.message : cause }, message);
      bus.emit('error:reported', { kind, message, ...(context ? { context } : {}) });
    },
  };
}
