import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HARDCODED_FALLBACK,
  PoliciesFile,
  type PolicyContext,
  type ResolvedPolicy,
} from './schema.js';

/**
 * Load a `policies.json` file. Returns `null` when the file doesn't
 * exist — caller decides whether to auto-generate, error out, or run
 * with the default policy.
 *
 * Throws on malformed JSON or schema violations: a typo'd policy file
 * is a configuration bug the operator must fix before the service can
 * make sound permission decisions.
 */
export function loadPolicies(path: string): PoliciesFile | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`policies.json: invalid JSON: ${(e as Error).message}`);
  }
  const result = PoliciesFile.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`policies.json: schema validation failed:\n${issues.join('\n')}`);
  }
  return result.data;
}

/**
 * Save a policies file. Creates the parent dir if missing and tightens
 * permissions to 0600 so it sits in the same security tier as the DB
 * and `.env`. Atomic-write via temp + rename so a crash mid-write can't
 * leave a half-written file.
 */
export function savePolicies(path: string, policies: PoliciesFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(policies, null, 2) + '\n', { mode: 0o600 });
  // rename is atomic on POSIX. Same fs guarantee the DB relies on.
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod can fail on shared volumes / Windows; not fatal.
  }
}

/**
 * Pick the first defined value across the layered policy sources.
 * Order: explicit context → parent (via _inherits) → file defaults →
 * hard-coded fallback. The first source with a non-undefined value wins.
 */
function pick<K extends keyof PolicyContext>(
  key: K,
  layers: ReadonlyArray<PolicyContext | undefined>,
): PolicyContext[K] | undefined {
  for (const layer of layers) {
    if (layer === undefined) continue;
    const v = layer[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Resolve the effective policy for a given context key. Layers
 * (most specific first):
 *
 *   1. The explicit context entry
 *   2. Its `_inherits` parent (one level only — chains throw)
 *   3. The file's `defaults` block
 *   4. {@link HARDCODED_FALLBACK} — conservative deny-by-default
 *
 * Returns a `ResolvedPolicy` (every field defined). Arrays are picked
 * as units, not merged — operators who want a union of patterns should
 * write the full list at the layer they want it to take effect.
 */
export function resolvePolicy(
  policies: PoliciesFile,
  contextKey: string,
): ResolvedPolicy {
  const explicit = policies.contexts[contextKey];
  let parent: PolicyContext | undefined;
  if (explicit?._inherits) {
    parent = policies.contexts[explicit._inherits];
    if (!parent) {
      throw new Error(
        `policies.json: context "${contextKey}" inherits from unknown parent "${explicit._inherits}"`,
      );
    }
    if (parent._inherits) {
      throw new Error(
        `policies.json: nested _inherits chains are not supported (${contextKey} → ${explicit._inherits} → ${parent._inherits})`,
      );
    }
  }

  const layers: ReadonlyArray<PolicyContext | undefined> = [
    explicit,
    parent,
    policies.defaults,
  ];

  const resolved: ResolvedPolicy = {
    scheduleKinds: pick('scheduleKinds', layers) ?? HARDCODED_FALLBACK.scheduleKinds,
    scheduleAgentTaskCap:
      pick('scheduleAgentTaskCap', layers) ?? HARDCODED_FALLBACK.scheduleAgentTaskCap,
    execMode: pick('execMode', layers) ?? HARDCODED_FALLBACK.execMode,
    execAllow: pick('execAllow', layers) ?? HARDCODED_FALLBACK.execAllow,
    skillsVisible: pick('skillsVisible', layers) ?? HARDCODED_FALLBACK.skillsVisible,
  };
  const deliverToChatId = pick('deliverToChatId', layers);
  if (deliverToChatId !== undefined) resolved.deliverToChatId = deliverToChatId;
  const label = explicit?._label ?? parent?._label;
  if (label !== undefined) resolved._label = label;
  return resolved;
}
