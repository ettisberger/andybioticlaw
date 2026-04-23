import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { expandPath } from '../config/paths.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { AppEventBus } from '../events/bus.js';
import type { ErrorReporter } from '../observability/errors.js';

const pexec = promisify(execFile);

export interface CredentialsCheckResult {
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface CredentialsCheckDeps {
  credentialsDir: string;
  logger: Logger;
  bus: AppEventBus;
  audit: AuditRepo;
  errors: ErrorReporter;
  /** Path to the claude CLI binary. Defaults to `claude` in PATH. */
  claudeBin?: string;
  /** Optional override for testing — bypasses the CLI call. */
  overrideCheck?: () => Promise<CredentialsCheckResult>;
}

/**
 * Env vars that MUST NOT be present when we invoke `claude` — any of these
 * silently switches the CLI from subscription auth to pay-as-you-go API
 * billing, or to a different provider. The runner filters them from every
 * subprocess env; the startup credentials check warns if the parent service
 * has any of them set.
 *
 * Note: `CLAUDE_CODE_OAUTH_TOKEN` is DELIBERATELY NOT on this list — it's a
 * subscription-bound long-lived OAuth token (`claude setup-token`), the same
 * billing path as a keyring session, not pay-as-you-go. We want it to pass
 * through to the subprocess.
 */
export const API_BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * `apiKeySource` values reported by `claude auth status --json` that indicate
 * pay-as-you-go API-key billing (NOT subscription). The runner SIGKILLs any
 * session whose init event reports one of these, and the startup check
 * refuses to boot. Everything else — `'none'` (keyring session) OR
 * unrecognized values paired with a truthy `subscriptionType` (e.g.
 * `CLAUDE_CODE_OAUTH_TOKEN` mode) — is accepted.
 *
 * Inverted from the original "accept only `'none'`" because the exact
 * `apiKeySource` value for `CLAUDE_CODE_OAUTH_TOKEN` auth isn't publicly
 * documented; a one-value accept-list risks boot-locking on future CLI
 * changes.
 */
export const API_KEY_SOURCE_REJECT = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

/**
 * Which subscription-bound auth path the service is using.
 *   - `'session'`: keyring credentials from `claude login`.
 *   - `'token'`: long-lived OAuth token via `CLAUDE_CODE_OAUTH_TOKEN`
 *                env var (from `claude setup-token`).
 *   - `'unknown'`: credentials appear valid (logged in + subscription)
 *                but the classification heuristic couldn't decide.
 */
export type AuthMethod = 'session' | 'token' | 'unknown';

/**
 * Check `claude auth status --json`, and interpret the result narrowly:
 * subscription auth ONLY. Pay-as-you-go API-key auth is explicitly rejected.
 *
 * Why this is strict:
 *   - With `ANTHROPIC_API_KEY` set in the environment, the CLI still reports
 *     `authMethod: "claude.ai"` and `loggedIn: true`, but `apiKeySource:
 *     "ANTHROPIC_API_KEY"` and `subscriptionType: null`. Runs billed against
 *     the API key would quietly drain the user's Anthropic account.
 *   - The spec requires subscription-backed auth ("Claude-Subscription-Auth,
 *     kein API-Key"). We enforce this at startup AND again on every session
 *     via the runner's init-event check.
 */
export async function checkClaudeCredentials(
  deps: CredentialsCheckDeps,
): Promise<CredentialsCheckResult> {
  if (deps.overrideCheck) return deps.overrideCheck();

  const bin = deps.claudeBin ?? 'claude';
  const expandedDir = expandPath(deps.credentialsDir);
  const dirExists = existsSync(expandedDir);

  // Pre-check: are we about to leak API-billing env vars into every spawn?
  const leakedEnv = API_BILLING_ENV_VARS.filter(
    (v) => process.env[v] !== undefined && process.env[v] !== '',
  );

  try {
    const { stdout } = await pexec(bin, ['auth', 'status', '--json'], { timeout: 10_000 });
    const parsed = JSON.parse(stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      email?: string;
      subscriptionType?: string | null;
      apiProvider?: string;
      apiKeySource?: string;
    };

    if (parsed.loggedIn !== true) {
      return {
        ok: false,
        reason: 'claude auth status reports not logged in',
        details: {
          credentialsDir: expandedDir,
          credentialsDirExists: dirExists,
          leakedEnv,
        },
      };
    }

    // Reject-list check: anything on the known API-billing list fails.
    const apiKeySource = parsed.apiKeySource ?? 'none';
    if (API_KEY_SOURCE_REJECT.has(apiKeySource)) {
      return {
        ok: false,
        reason: `claude is configured for API-key billing (apiKeySource=${apiKeySource}); this service requires subscription auth only`,
        details: {
          method: 'claude-auth-status',
          credentialsDir: expandedDir,
          apiKeySource,
          subscriptionType: parsed.subscriptionType,
          leakedEnv,
          hint: `unset ${leakedEnv.join(', ') || 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN'} in the service environment, or they will override the subscription and silently switch billing to pay-as-you-go`,
        },
      };
    }

    if (!parsed.subscriptionType) {
      return {
        ok: false,
        reason: 'claude reports logged in but with no subscription tier — this service requires a Claude subscription (Pro/Max), not API-key access',
        details: {
          method: 'claude-auth-status',
          credentialsDir: expandedDir,
          authMethod: parsed.authMethod,
          apiKeySource,
          leakedEnv,
        },
      };
    }

    // Classify which auth path is active. A non-empty CLAUDE_CODE_OAUTH_TOKEN
    // env var means the CLI is using the long-lived token. Otherwise
    // `apiKeySource === 'none'` means keyring session. Anything else is
    // accepted (we're past the reject-list) but flagged as 'unknown' so the
    // observed value shows up in audit logs for future investigation.
    const tokenEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasTokenEnv = typeof tokenEnv === 'string' && tokenEnv.trim() !== '';
    let authMethod: AuthMethod;
    if (hasTokenEnv) {
      authMethod = 'token';
    } else if (apiKeySource === 'none') {
      authMethod = 'session';
    } else {
      authMethod = 'unknown';
    }

    const details: Record<string, unknown> = {
      method: 'claude-auth-status',
      credentialsDir: expandedDir,
      credentialsDirExists: dirExists,
      authMethod,
      claudeAuthMethod: parsed.authMethod,
      subscriptionType: parsed.subscriptionType,
      apiKeySource,
    };
    if (parsed.email) details.email = parsed.email;
    if (parsed.apiProvider) details.apiProvider = parsed.apiProvider;
    if (leakedEnv.length > 0) details.leakedEnvWarning = leakedEnv;
    if (authMethod === 'unknown') {
      details.unknownApiKeySourceWarning = apiKeySource;
    }
    return { ok: true, details };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: `could not query claude CLI (${errMsg})`,
      details: {
        credentialsDir: expandedDir,
        credentialsDirExists: dirExists,
        fallback: 'directory-existence-only',
        leakedEnv,
        hint: dirExists
          ? 'credentials dir exists but `claude auth status` failed — verify the CLI is installed for the service user and run `claude login` if needed'
          : `credentials dir is missing — run \`claude login\` as the service user to create it (expected at ${expandedDir})`,
      },
    };
  }
}

/**
 * Perform the startup credentials check and log/report the result. Returns
 * the same `CredentialsCheckResult` so callers (e.g. bootstrap) can gate any
 * UX decisions on it.
 */
export async function runStartupCredentialsCheck(
  deps: CredentialsCheckDeps,
): Promise<CredentialsCheckResult> {
  const result = await checkClaudeCredentials(deps);

  const leaked = result.details?.['leakedEnv'];
  const hasLeakedEnv = Array.isArray(leaked) && leaked.length > 0;

  if (result.ok) {
    deps.logger.info(
      {
        method: result.details?.method,
        credentialsDir: result.details?.credentialsDir,
        subscriptionType: result.details?.subscriptionType,
        authMethod: result.details?.authMethod,
      },
      `claude credentials OK (subscription: ${String(result.details?.subscriptionType)}, auth: ${String(result.details?.authMethod)})`,
    );
    if (hasLeakedEnv) {
      deps.logger.warn(
        { leakedEnv: leaked },
        'API-billing env vars are set in the service env; the runner strips them from subprocesses but you should unset them to be safe',
      );
      deps.audit.record({
        kind: 'api_billing_env_warning',
        actor: 'startup',
        detail: { leakedEnv: leaked },
      });
    }
    const unknownSrc = result.details?.['unknownApiKeySourceWarning'];
    if (typeof unknownSrc === 'string') {
      deps.logger.warn(
        { apiKeySource: unknownSrc },
        'claude reports an unrecognised apiKeySource (paired with a valid subscription tier); accepting but check the CLI version + docs if this is unexpected',
      );
      deps.audit.record({
        kind: 'unknown_api_key_source',
        actor: 'startup',
        detail: { apiKeySource: unknownSrc },
      });
    }
  } else {
    deps.logger.error(
      { reason: result.reason, ...(result.details ?? {}) },
      'claude credentials unavailable — agent will refuse new messages until fixed',
    );
    deps.audit.record({
      kind: 'credentials_missing',
      actor: 'startup',
      detail: { reason: result.reason, ...result.details },
    });
    deps.errors.report({
      kind: 'credentials_missing',
      message: `claude credentials unavailable: ${result.reason ?? 'unknown'}`,
      ...(result.details ? { context: result.details } : {}),
    });
  }
  deps.bus.emit('credentials:status-changed', {
    ok: result.ok,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.details ? { details: result.details } : {}),
  });
  return result;
}
