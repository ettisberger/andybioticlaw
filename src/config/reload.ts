import type { Logger } from 'pino';
import type { Config } from './schema.js';
import { HOT_RELOADABLE_PATHS, RESTART_REQUIRED_PATHS } from './schema.js';
import { loadConfig, ConfigLoadError } from './load.js';
import type { AppEventBus } from '../events/bus.js';

type ChangedField = {
  path: string;
  from: unknown;
  to: unknown;
  hotReloadable: boolean;
};

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function equalDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!equalDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

function diff(oldCfg: Config, newCfg: Config): ChangedField[] {
  const changed: ChangedField[] = [];
  const all = [...HOT_RELOADABLE_PATHS, ...RESTART_REQUIRED_PATHS];
  for (const path of all) {
    const from = getByPath(oldCfg, path);
    const to = getByPath(newCfg, path);
    if (!equalDeep(from, to)) {
      changed.push({
        path,
        from,
        to,
        hotReloadable: (HOT_RELOADABLE_PATHS as readonly string[]).includes(path),
      });
    }
  }
  return changed;
}

export interface ConfigHandle {
  current(): Config;
  onReload(listener: (next: Config) => void): void;
}

export interface ReloadController extends ConfigHandle {
  reload(): ReloadOutcome;
  installSighupHandler(): void;
}

export type ReloadOutcome =
  | { ok: true; changed: ChangedField[]; config: Config }
  | { ok: false; reason: string };

/**
 * Wraps a mutable config reference with a SIGHUP-triggered reload.
 *
 * Hot-reloadable fields update the in-memory config and fire `config:reloaded`
 * on the event bus, including the list of changed fields so downstream
 * subscribers (logger level, heartbeat interval, budget cap, etc.) can react.
 *
 * Restart-required fields log a warning but do NOT update the in-memory value,
 * avoiding a mismatch between the running service and any persistent state
 * that was already initialized from the old value (e.g. bound Telegram token).
 */
export function createReloadController(
  initial: Config,
  bus: AppEventBus,
  logger: Logger,
): ReloadController {
  let current = initial;
  const listeners = new Set<(next: Config) => void>();

  function reload(): ReloadOutcome {
    let next: Config;
    try {
      next = loadConfig().config;
    } catch (e) {
      if (e instanceof ConfigLoadError) {
        logger.error({ err: e.message, kind: e.kind }, 'config reload failed — keeping existing');
        return { ok: false, reason: e.message };
      }
      logger.error({ err: e }, 'config reload failed — keeping existing');
      return { ok: false, reason: (e as Error).message };
    }

    const changes = diff(current, next);
    if (changes.length === 0) {
      logger.info('config reload: no changes detected');
      return { ok: true, changed: [], config: current };
    }

    const hot = changes.filter((c) => c.hotReloadable);
    const cold = changes.filter((c) => !c.hotReloadable);

    for (const c of cold) {
      logger.warn(
        { field: c.path, was: c.from, now: c.to },
        `field ${c.path} changed but requires restart — keeping old value`,
      );
    }

    if (hot.length > 0) {
      // Apply hot changes by swapping the in-memory config. Downstream listeners
      // read fields lazily via `current()` so they pick up the new values.
      current = buildHotApplied(current, next, hot);
      logger.info(
        { fields: hot.map((h) => h.path) },
        `config reload: ${hot.length} field(s) hot-reloaded`,
      );
      for (const l of listeners) l(current);
      bus.emit('config:reloaded', { changed: hot.map((c) => c.path), config: current });
    } else {
      logger.info('config reload: only restart-required fields changed');
    }

    return { ok: true, changed: changes, config: current };
  }

  function installSighupHandler(): void {
    process.on('SIGHUP', () => {
      logger.info('received SIGHUP — reloading config');
      reload();
    });
  }

  return {
    current: () => current,
    onReload: (l) => {
      listeners.add(l);
    },
    reload,
    installSighupHandler,
  };
}

/**
 * Copies `next` into `current` only for the specified hot-reloadable paths.
 * Works in-place on a structured clone.
 */
function buildHotApplied(current: Config, next: Config, hot: ChangedField[]): Config {
  const clone = structuredClone(current) as Record<string, unknown>;
  for (const c of hot) {
    setByPath(clone, c.path, c.to);
  }
  return clone as unknown as Config;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (!next || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}
