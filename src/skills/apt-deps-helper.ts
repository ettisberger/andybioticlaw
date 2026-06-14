import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config/load.js';

/**
 * Read a single skill's manifest from disk to extract `apt_dependencies`.
 *
 * This intentionally bypasses the full skill loader + DB registry path
 * because `andybioticlaw skill apt-deps <name>` MUST be runnable by the
 * operator's normal user (the one with sudo). The full path opens
 * `.env` and the SQLite DB, both owned 0600 by the service user, and
 * would `EACCES` for the operator.
 *
 * We only need one declarative field from the manifest, so we skip the
 * zod parse entirely and just look at the YAML's `apt_dependencies`
 * array. Anything malformed → reported as an error, not crashed on.
 */
export type AptDepsResult =
  | {
      kind: 'ok';
      aptDependencies: string[];
      manifestPath: string;
    }
  | {
      kind: 'not-found';
      skillsDir: string;
    }
  | {
      kind: 'invalid-manifest';
      manifestPath: string;
      error: string;
    };

export function readSkillManifestForApt(
  skillName: string,
  skillsDirOverride?: string,
): AptDepsResult {
  // Default skills dir under the install root. We don't read config.yaml
  // either — most installs use the convention; the optional
  // `skillsDirOverride` covers anyone with a non-default `skills.dir`.
  const skillsDir = skillsDirOverride
    ? resolve(skillsDirOverride)
    : resolve(projectRoot(), 'skills');
  const manifestPath = resolve(skillsDir, skillName, 'manifest.yaml');

  if (!existsSync(manifestPath)) {
    return { kind: 'not-found', skillsDir };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return {
      kind: 'invalid-manifest',
      manifestPath,
      error: `YAML parse error: ${(e as Error).message}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      kind: 'invalid-manifest',
      manifestPath,
      error: 'manifest root is not an object',
    };
  }

  const apt = (parsed as Record<string, unknown>).apt_dependencies;
  if (apt === undefined || apt === null) {
    return { kind: 'ok', aptDependencies: [], manifestPath };
  }
  if (!Array.isArray(apt)) {
    return {
      kind: 'invalid-manifest',
      manifestPath,
      error: '`apt_dependencies` must be an array of strings',
    };
  }
  const deps: string[] = [];
  for (const v of apt) {
    if (typeof v !== 'string') {
      return {
        kind: 'invalid-manifest',
        manifestPath,
        error: '`apt_dependencies` entries must all be strings',
      };
    }
    deps.push(v);
  }
  return { kind: 'ok', aptDependencies: deps, manifestPath };
}
