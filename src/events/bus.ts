import { EventEmitter } from 'node:events';
import type { Config } from '../config/schema.js';

/**
 * Typed event bus. Keep the event map narrow — each entry documents the single
 * producer and known consumers so we don't end up with drive-by emits.
 *
 * Events declared so far (Phase 1):
 *
 *   config:reloaded
 *     - producer: src/config/reload.ts
 *     - consumers: logger level updater, heartbeat interval updater
 *
 *   credentials:status-changed
 *     - producer: src/agent/credentials.ts (after startup check or re-check)
 *     - consumers: Phase 2 Telegram handler, Phase 5 dashboard overview
 *
 *   error:reported
 *     - producer: src/observability/errors.ts
 *     - consumers: Phase 2 Telegram admin-DM sender
 *
 * Extend the AppEvents interface alongside the code that emits/consumes.
 */
export interface AppEvents {
  'config:reloaded': { changed: string[]; config: Config };
  'credentials:status-changed': {
    ok: boolean;
    reason?: string;
    details?: Record<string, unknown>;
  };
  'error:reported': {
    kind: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

type EventName = keyof AppEvents;

export interface AppEventBus {
  emit<K extends EventName>(event: K, payload: AppEvents[K]): void;
  on<K extends EventName>(event: K, listener: (payload: AppEvents[K]) => void): void;
  off<K extends EventName>(event: K, listener: (payload: AppEvents[K]) => void): void;
}

export function createEventBus(): AppEventBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(32);
  return {
    emit(event, payload) {
      ee.emit(event, payload);
    },
    on(event, listener) {
      ee.on(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      ee.off(event, listener as (...args: unknown[]) => void);
    },
  };
}
