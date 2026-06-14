import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { projectRoot } from '../config/load.js';

/**
 * Resolve an apt-dependency spec to a single installable package name.
 *
 * A spec is either a bare package name (`libnss3`) or a pipe-delimited
 * alternation (`libasound2 | libasound2t64`). For alternations we pick
 * the first entry that `apt-cache show` reports as an installable
 * candidate. This is what lets one manifest cover both Ubuntu 22.04
 * (`libasound2`) and Ubuntu 24.04+ where the package was renamed
 * under the t64 ABI transition (`libasound2t64`).
 *
 * Fallback rules:
 *   - Bare name → return as-is.
 *   - Alternation with at least one installable → return the first.
 *   - Alternation with none installable, or `apt-cache` missing
 *     (non-Debian host) → return the FIRST entry. The caller will then
 *     fail at `dpkg-query` time with a clear "missing" diagnostic
 *     pointing at that name, which is fine — better than this helper
 *     guessing.
 */
export function resolveAptAlternation(spec: string): string {
  const alternatives = spec.split('|').map((s) => s.trim()).filter(Boolean);
  if (alternatives.length === 0) return spec.trim();
  if (alternatives.length === 1) return alternatives[0]!;
  // Probe each via apt-cache show. spawnSync with stdio:ignore returns
  // status===0 only when the package has an installable record.
  for (const alt of alternatives) {
    const r = spawnSync('apt-cache', ['show', alt], { stdio: 'ignore' });
    if (r.status === 0) return alt;
  }
  return alternatives[0]!;
}

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
    deps.push(resolveAptAlternation(v));
  }
  return { kind: 'ok', aptDependencies: deps, manifestPath };
}
