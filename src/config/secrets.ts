import type { AuditRepo } from '../db/repositories/audit.js';

/**
 * Secrets scoping.
 *
 * - `core` scope: only the hard-coded allowlist below. Used by the core service
 *   for Telegram, dashboard Basic Auth, etc. Skill-specific secrets are NEVER
 *   readable from core scope (you must request them via `{ skill: '<name>' }`).
 * - `{ skill: '<name>' }` scope: only secrets listed in that skill's
 *   `manifest.yaml` under `required_secrets`. Enforced by the skill loader;
 *   this module is the runtime gate.
 *
 * Any attempt to read a secret outside the caller's scope throws a
 * `SecretScopeViolationError` AND writes an `audit` row of kind
 * `secret_scope_violation`. The caller should propagate the error.
 */

// `.env` holds TELEGRAM_BOT_TOKEN (mandatory) and optionally
// CLAUDE_CODE_OAUTH_TOKEN (long-lived subscription OAuth token — from
// `claude setup-token`). The dashboard's basic-auth is verified against an
// argon2 hash in config.yaml (`dashboard.basicAuth.passwordHash`) — never
// a plain password in env. Declaring CLAUDE_CODE_OAUTH_TOKEN here gives us
// scope-violation auditing if a skill ever tries to read it.
export const CORE_SECRETS = ['TELEGRAM_BOT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
export type CoreSecret = (typeof CORE_SECRETS)[number];

export type SecretContext = 'core' | { skill: string };

export class SecretScopeViolationError extends Error {
  readonly secretName: string;
  readonly requestedBy: string;

  constructor(secretName: string, requestedBy: string) {
    super(`secret ${secretName} not accessible from scope ${requestedBy}`);
    this.name = 'SecretScopeViolationError';
    this.secretName = secretName;
    this.requestedBy = requestedBy;
  }
}

export interface SecretsStore {
  /** Returns the secret value or undefined if unset (even if allowed). */
  get(name: string): string | undefined;
  /** Returns the set of declared-but-missing secrets for auditing. */
  list(): string[];
}

export interface SkillPermissions {
  /** Returns `required_secrets` from the skill's manifest. Empty if skill is unknown. */
  requiredSecrets(skillName: string): ReadonlyArray<string>;
}

export interface SecretsManagerDeps {
  store: SecretsStore;
  skills: SkillPermissions;
  audit: AuditRepo;
}

/**
 * Construct a scoped secret accessor. Callers pass a context identifying their
 * scope; attempts to read outside that scope throw and are audited.
 */
export function createSecretsManager(deps: SecretsManagerDeps) {
  const { store, skills, audit } = deps;

  function contextLabel(ctx: SecretContext): string {
    return ctx === 'core' ? 'core' : `skill:${ctx.skill}`;
  }

  function getSecret(name: string, ctx: SecretContext): string | undefined {
    const allowed =
      ctx === 'core'
        ? (CORE_SECRETS as readonly string[]).includes(name)
        : skills.requiredSecrets(ctx.skill).includes(name);

    if (!allowed) {
      audit.record({
        kind: 'secret_scope_violation',
        actor: contextLabel(ctx),
        detail: { secretName: name },
      });
      throw new SecretScopeViolationError(name, contextLabel(ctx));
    }
    return store.get(name);
  }

  /** Lists secret NAMES (never values) declared by core + any active skill. */
  function audit_list(): Array<{ name: string; referencedBy: string[] }> {
    const map = new Map<string, string[]>();
    for (const core of CORE_SECRETS) {
      map.set(core, ['core']);
    }
    // Skills are registered at runtime; we only have what `skills` exposes.
    // The installer/registry is expected to register each active skill's
    // required_secrets before this is called.
    return Array.from(map.entries()).map(([name, referencedBy]) => ({ name, referencedBy }));
  }

  return { getSecret, audit_list };
}

/**
 * Default `SecretsStore` backed by `process.env`. The secrets should already
 * have been loaded from `.env` via `bootstrapEnv()`.
 */
export function envSecretsStore(): SecretsStore {
  return {
    get: (name) => process.env[name],
    list: () => Object.keys(process.env),
  };
}

/**
 * Default `SkillPermissions` that reads from a snapshot Map. Prefer
 * `liveSkillPermissions()` in production — a snapshot taken at service
 * startup misses skills added later via SIGHUP skill-rescan.
 */
export function staticSkillPermissions(
  table: ReadonlyMap<string, ReadonlyArray<string>>,
): SkillPermissions {
  return {
    requiredSecrets: (skillName) => table.get(skillName) ?? [],
  };
}

/**
 * `SkillPermissions` backed by a thunk that re-reads the registry on every
 * call. Use this in the service wiring so SIGHUP-added skills can resolve
 * their secrets without a restart.
 */
export function liveSkillPermissions(
  getTable: () => ReadonlyMap<string, ReadonlyArray<string>>,
): SkillPermissions {
  return {
    requiredSecrets: (skillName) => getTable().get(skillName) ?? [],
  };
}
