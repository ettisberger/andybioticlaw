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

export const SkillManifest = z.object({
  name: z.string().regex(NAME_RE, 'name must be kebab-case, starting with a letter'),
  version: z.string().regex(SEMVER_RE, 'version must be semver'),
  description: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
  scope: z.array(SkillScope).nonempty().default(['dm']),
  required_secrets: z
    .array(z.string().regex(SECRET_NAME_RE, 'secret names must be UPPER_SNAKE_CASE'))
    .default([]),
  apt_dependencies: z.array(z.string()).default([]),
  system_commands: z.array(z.string()).default([]),
  mcp_servers: z.array(McpServerConfig).default([]),
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
