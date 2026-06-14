/**
 * Per-session `.claude/settings.json` generator.
 *
 * Claude Code reads a settings file at the path given via `--settings`.
 * The shape we care about is `permissions.allow` (Bash/etc patterns
 * the agent is allowed to invoke without approval) and `defaultMode`
 * (which controls whether unmatched calls prompt or fail).
 *
 * We compose a per-session settings file by merging:
 *   1. The resolved policy's `execAllow` patterns (operator-controlled
 *      via `data/policies.json`)
 *   2. Each active skill's `exec_allow` patterns (declared in skill
 *      manifests; the operator audits these on `andybioticlaw skill
 *      install <name>`)
 *
 * The `defaultMode` field is derived from the resolved policy's
 * `execMode`:
 *   - 'full'      → 'bypassPermissions'  (matches today's behaviour;
 *                                          mirror for `--permission-mode bypassPermissions`)
 *   - 'allowlist' → 'default'  (Claude prompts on unmatched, but our
 *                               headless runner doesn't surface prompts —
 *                               unmatched effectively becomes deny)
 *   - 'deny'      → 'default'  (same as above, but with NO patterns the
 *                               policy contributes — only skill patterns)
 */

import type { ResolvedPolicy } from '../policies/schema.js';

export interface SkillExecPattern {
  /** Skill id, recorded on each pattern for audit / debugging. */
  skill: string;
  /** A `Bash(...)` pattern (or whatever Claude Code's permission grammar accepts). */
  pattern: string;
}

/**
 * Shape of the generated `.claude/settings.json`. Only includes the
 * fields we actively control — Claude Code is forgiving about unknown
 * keys but we keep the file small for readability when the operator
 * inspects a session workspace post-mortem.
 */
export interface ClaudeSessionSettings {
  permissions: {
    /** Patterns the agent may run without prompting. */
    allow: string[];
    /** Patterns the agent must NEVER run, even with approval. We don't
     *  populate this today, but the field is reserved for the future
     *  when policies grow a `denyExec` axis. */
    deny: string[];
    /**
     * - 'bypassPermissions' = no checks (today's behaviour)
     * - 'default' = check against `allow`; unmatched → prompt (our
     *               headless runner has nowhere to surface prompts so
     *               unmatched effectively fails the tool call)
     */
    defaultMode: 'bypassPermissions' | 'default';
  };
  /** Inline annotations for post-mortem inspection. Skipped by Claude. */
  _meta: {
    generatedBy: 'andybioticlaw';
    contextKey: string;
    execMode: ResolvedPolicy['execMode'];
    skillContributions: SkillExecPattern[];
    policyContributions: string[];
  };
}

export interface BuildSettingsInput {
  policy: ResolvedPolicy;
  /** Skills active in this session — we read their `execAllow` lists. */
  skills: ReadonlyArray<{ name: string; execAllow: ReadonlyArray<string> }>;
  contextKey: string;
}

export function buildClaudeSessionSettings(input: BuildSettingsInput): ClaudeSessionSettings {
  const policyPatterns = [...input.policy.execAllow];

  // Each skill contributes its declared exec_allow patterns. Tagged
  // by skill id so the _meta block tells the operator which skill is
  // responsible for each entry.
  const skillContributions: SkillExecPattern[] = [];
  for (const skill of input.skills) {
    for (const pattern of skill.execAllow) {
      skillContributions.push({ skill: skill.name, pattern });
    }
  }

  // Combine + dedupe. Order: policy patterns first (operator-explicit),
  // then skill patterns. Dedup is exact-string — Claude Code's pattern
  // matcher can handle multiple equivalents but keeping the file tidy
  // helps debugging.
  const seen = new Set<string>();
  const allow: string[] = [];
  const push = (p: string): void => {
    if (seen.has(p)) return;
    seen.add(p);
    allow.push(p);
  };
  for (const p of policyPatterns) push(p);
  for (const c of skillContributions) push(c.pattern);

  // Mode derivation. `'full'` → bypass everything (today's behaviour);
  // any other mode → headless `default` so unmatched calls fail closed
  // (no prompt UI in our pipeline, so unmatched = denied).
  const defaultMode: 'bypassPermissions' | 'default' =
    input.policy.execMode === 'full' ? 'bypassPermissions' : 'default';

  // Per-skill tool denials. When the `browser` skill is active, deny
  // the built-in `WebFetch` tool outright — Emma reaches for it
  // reflexively even when the browser_* tools would render JS-heavy
  // sites correctly + carry per-profile auth. With WebFetch on the
  // deny list she has no escape hatch and must use the right tool.
  // Note: this only fires under `default` permission mode; the
  // existing `bypassPermissions` path ignores deny entries.
  const deny: string[] = [];
  const browserActive = input.skills.some((s) => s.name === 'browser');
  if (browserActive) deny.push('WebFetch');

  return {
    permissions: {
      allow,
      deny,
      defaultMode,
    },
    _meta: {
      generatedBy: 'andybioticlaw',
      contextKey: input.contextKey,
      execMode: input.policy.execMode,
      skillContributions,
      policyContributions: policyPatterns,
    },
  };
}
