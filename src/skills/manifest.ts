import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

export const McpServerConfig = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'mcp server name must be kebab-case'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export const SkillScope = z.enum(['dm', 'group']);
export type SkillScope = z.infer<typeof SkillScope>;

/**
 * Optional "setup wizard" block declaring the questions the CLI wizard asks
 * when installing this skill. One question per env-var the skill needs.
 *
 * The wizard skips any key that's already non-empty in `.env` (the CLI
 * prints "already set, reusing" and moves on), writes newly-collected
 * values, then calls `install.sh`. Secrets are masked while typing.
 */
export const WizardQuestion = z.object({
  /** Env var name — must match one of `required_secrets` to be injectable. */
  key: z.string().regex(SECRET_NAME_RE, 'wizard key must be UPPER_SNAKE_CASE'),
  /** Prompt the user sees. */
  prompt: z.string().min(1).max(300),
  /** Default value used when the user just presses Enter. */
  default: z.string().optional(),
  /** If true: no echo while typing, and the value is shown as "***" in logs. */
  secret: z.boolean().default(false),
  /** Crude built-in validators. */
  validate: z.enum(['nonempty', 'email', 'port', 'url']).optional(),
  /** Longer explanation shown before the prompt (one line). */
  help: z.string().max(500).optional(),
});
export type WizardQuestion = z.infer<typeof WizardQuestion>;

export const SetupWizard = z.object({
  description: z.string().min(1).max(500),
  questions: z.array(WizardQuestion).default([]),
});
export type SetupWizard = z.infer<typeof SetupWizard>;

export const SkillManifest = z.object({
  name: z.string().regex(NAME_RE, 'name must be kebab-case, starting with a letter'),
  version: z.string().regex(SEMVER_RE, 'version must be semver'),
  description: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
  scope: z.array(SkillScope).nonempty().default(['dm']),
  /**
   * Optional semver. When set, the loader rejects this skill if the core
   * service's version (from package.json) is lower. Useful when a skill
   * depends on a core feature added in a specific release. Simple
   * minimum-version semantic — no range expressions; "0.2.0" means
   * "this skill needs core ≥ 0.2.0".
   */
  core_required: z.string().regex(SEMVER_RE, 'core_required must be a bare semver like "0.2.0"').optional(),
  required_secrets: z
    .array(z.string().regex(SECRET_NAME_RE, 'secret names must be UPPER_SNAKE_CASE'))
    .default([]),
  apt_dependencies: z.array(z.string()).default([]),
  system_commands: z.array(z.string()).default([]),
  mcp_servers: z.array(McpServerConfig).default([]),
  /** Optional CLI wizard triggered by `andybioticlaw skill setup <name>`. */
  setup_wizard: SetupWizard.optional(),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

export interface ManifestLoadResult {
  manifest: SkillManifest;
  path: string;
}

export class SkillManifestError extends Error {
  readonly issues: string[];

  constructor(path: string, issues: string[]) {
    super(`invalid skill manifest at ${path}:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'SkillManifestError';
    this.issues = issues;
  }
}

/**
 * Parse and validate a skill's `manifest.yaml`. Also enforces the invariant
 * that `name` equals the folder name — saves a class of confusing bugs.
 */
export function loadManifest(skillDir: string, folderName: string): ManifestLoadResult {
  const path = resolve(skillDir, 'manifest.yaml');
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new SkillManifestError(path, [`YAML parse error: ${(e as Error).message}`]);
  }
  const result = SkillManifest.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new SkillManifestError(path, issues);
  }
  if (result.data.name !== folderName) {
    throw new SkillManifestError(path, [
      `manifest.name "${result.data.name}" does not match folder "${folderName}"`,
    ]);
  }
  return { manifest: result.data, path };
}
