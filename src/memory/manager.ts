import type { Logger } from 'pino';
import type { MemoryRepo, MemoryRecord } from '../db/repositories/memory.js';

/**
 * Scope grammar:
 *   global                — applies to all sessions
 *   user:<telegram-id>    — applies when principal user id matches
 *   chat:<chat-id>        — applies when chat id matches
 *   skill:<skill-name>    — applies when the named skill is active in the session scope
 *
 * Additional free-form scopes are allowed (e.g. "project:foo"), but the manager
 * only auto-includes the four canonical forms in its active-scope resolution.
 */

export interface ActiveScopeInput {
  principalUserId: number | null;
  chatId: string | null;
  activeSkills: string[];
  /** Always include `global`. Defaults to true; set false in narrow CLI flows. */
  includeGlobal?: boolean;
  /** Extra literal scopes to union in (advanced). */
  extraScopes?: string[];
}

export interface MemorySnapshot {
  entries: MemoryRecord[];
  scopes: string[];
  truncated: number;
}

export interface MemoryManagerDeps {
  repo: MemoryRepo;
  logger: Logger;
  /** Optional clock for tests. */
  now?: () => number;
}

export interface MemoryManager {
  resolveActiveScopes(input: ActiveScopeInput): string[];
  snapshot(input: ActiveScopeInput, maxEntries?: number): MemorySnapshot;
  addManual(args: { scope: string; value: string; key?: string; ttlSeconds?: number }): MemoryRecord;
  remove(id: number): boolean;
  listByScope(scope: string, limit?: number): MemoryRecord[];
  listAll(limit?: number): MemoryRecord[];
  runTtlCleanup(): number;
  validateScope(scope: string): { ok: true } | { ok: false; reason: string };
}

const VALID_SCOPE_RE = /^(global|user:[\w\-.]+|chat:-?[\w\-.]+|skill:[a-z0-9-]+|[a-z0-9_-]+:[\w\-.]+)$/;

export function createMemoryManager(deps: MemoryManagerDeps): MemoryManager {
  const now = deps.now ?? (() => Date.now());

  function validateScope(scope: string): { ok: true } | { ok: false; reason: string } {
    if (scope.length === 0 || scope.length > 128) {
      return { ok: false, reason: 'scope must be 1..128 chars' };
    }
    if (!VALID_SCOPE_RE.test(scope)) {
      return {
        ok: false,
        reason: `scope "${scope}" is malformed — expected "global" or "<prefix>:<identifier>"`,
      };
    }
    return { ok: true };
  }

  function resolveActiveScopes(input: ActiveScopeInput): string[] {
    const scopes = new Set<string>();
    if (input.includeGlobal !== false) scopes.add('global');
    if (input.principalUserId !== null) scopes.add(`user:${input.principalUserId}`);
    if (input.chatId !== null) scopes.add(`chat:${input.chatId}`);
    for (const skill of input.activeSkills) scopes.add(`skill:${skill}`);
    for (const extra of input.extraScopes ?? []) scopes.add(extra);
    return Array.from(scopes);
  }

  return {
    validateScope,
    resolveActiveScopes,
    snapshot(input, maxEntries = 50) {
      const scopes = resolveActiveScopes(input);
      const all = deps.repo.listActive(scopes, now());
      const truncated = Math.max(0, all.length - maxEntries);
      return {
        entries: all.slice(0, maxEntries),
        scopes,
        truncated,
      };
    },
    addManual({ scope, value, key, ttlSeconds }) {
      const check = validateScope(scope);
      if (!check.ok) throw new Error(check.reason);
      if (!value || value.trim().length === 0) throw new Error('value must be non-empty');
      const ttl_at = ttlSeconds !== undefined ? now() + ttlSeconds * 1000 : null;
      return deps.repo.create({
        scope,
        value: value.trim(),
        key: key ?? null,
        source: 'manual',
        ttl_at,
      });
    },
    remove(id) {
      return deps.repo.remove(id);
    },
    listByScope(scope, limit = 100) {
      return deps.repo.list({ scope, limit });
    },
    listAll(limit = 100) {
      return deps.repo.list({ limit });
    },
    runTtlCleanup() {
      const removed = deps.repo.deleteExpired(now());
      if (removed > 0) deps.logger.debug({ removed }, 'memory TTL cleanup ran');
      return removed;
    },
  };
}

/**
 * Format a memory snapshot as a bullet list suitable for inclusion in the
 * assembled system prompt. Matches the shape `assembleContext` already expects.
 */
export function snapshotToContextFragment(snapshot: MemorySnapshot): {
  scope: string;
  key: string | null;
  value: string;
}[] {
  return snapshot.entries.map((e) => ({ scope: e.scope, key: e.key, value: e.value }));
}
