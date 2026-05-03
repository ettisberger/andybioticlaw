import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { loadManifest, SkillManifestError } from './manifest.js';
import type { SkillRegistry, SkillRecord } from './registry.js';
import { readPackageVersion } from '../version.js';

/** MCP server names the core owns; skills may not register these. */
const RESERVED_MCP_NAMES = new Set(['andybioticlaw-memory']);

/** Parse "X.Y.Z[-suffix]" → [X, Y, Z]; pre-release suffix is ignored. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns true iff `core` satisfies the skill's `core_required` minimum. */
function isCoreCompatible(core: string, required: string): boolean {
  const c = parseSemver(core);
  const r = parseSemver(required);
  if (!c || !r) return true; // be permissive on malformed versions
  if (c[0] !== r[0]) return c[0] > r[0];
  if (c[1] !== r[1]) return c[1] > r[1];
  return c[2] >= r[2];
}

export interface SkillLoadOptions {
  dir: string;
  logger: Logger;
  registry: SkillRegistry;
  /** Override for tests. Defaults to reading package.json at projectRoot(). */
  coreVersion?: string;
}

export interface SkillLoadResult {
  scanned: number;
  loaded: number;
  failed: Array<{ name: string; error: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Scan `dir` for skill folders, parse each `manifest.yaml`, read `SKILL.md`,
 * and register the result in the provided registry.
 *
 * Folders whose name starts with `_` (including `_template`) are skipped by
 * convention. A folder missing `manifest.yaml` OR `SKILL.md` is recorded in
 * `skipped`; a folder whose manifest fails validation is recorded in `failed`
 * (service keeps running — one bad skill must not break the service boot).
 */
export function loadSkills(opts: SkillLoadOptions): SkillLoadResult {
  const result: SkillLoadResult = { scanned: 0, loaded: 0, failed: [], skipped: [] };

  if (!existsSync(opts.dir)) {
    opts.logger.warn({ dir: opts.dir }, 'skills dir missing — 0 skills loaded');
    return result;
  }

  for (const entry of readdirSync(opts.dir)) {
    if (entry === 'README.md') continue;
    const full = resolve(opts.dir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    result.scanned += 1;

    if (entry.startsWith('_')) {
      result.skipped.push({ name: entry, reason: 'underscore-prefixed (reserved)' });
      continue;
    }
    const manifestPath = resolve(full, 'manifest.yaml');
    const skillMdPath = resolve(full, 'SKILL.md');
    if (!existsSync(manifestPath)) {
      result.skipped.push({ name: entry, reason: 'missing manifest.yaml' });
      continue;
    }
    if (!existsSync(skillMdPath)) {
      result.skipped.push({ name: entry, reason: 'missing SKILL.md' });
      continue;
    }

    try {
      const { manifest } = loadManifest(full, entry);

      // Reject manifests that try to hijack core-owned MCP server names.
      // Checked at load-time (not session-time) so the operator sees the
      // failure loudly via the existing result.failed → errors.report path.
      const reservedClash = manifest.mcp_servers.find((srv) =>
        RESERVED_MCP_NAMES.has(srv.name),
      );
      if (reservedClash) {
        throw new SkillManifestError(manifestPath, [
          `mcp server name "${reservedClash.name}" is reserved for the core service — rename it in manifest.yaml`,
        ]);
      }

      // Reject manifests that declare a core_required minimum we don't meet.
      if (manifest.core_required) {
        const core = opts.coreVersion ?? readPackageVersion();
        if (!isCoreCompatible(core, manifest.core_required)) {
          throw new SkillManifestError(manifestPath, [
            `skill requires core ≥ ${manifest.core_required}, but running core is ${core}`,
          ]);
        }
      }

      const skillMdContent = readFileSync(skillMdPath, 'utf8');
      const record: SkillRecord = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: manifest.enabled,
        scope: manifest.scope,
        requiredSecrets: manifest.required_secrets,
        aptDependencies: manifest.apt_dependencies,
        systemCommands: manifest.system_commands,
        mcpServers: manifest.mcp_servers,
        execAllow: manifest.exec_allow,
        setupWizard: manifest.setup_wizard,
        manifestPath,
        skillMdPath,
        skillDir: full,
      };
      // Side-effect: the SKILL.md content isn't kept on the registry record
      // (it's re-read at session assembly time so live edits take effect
      // without restart); we touch it here only to fail early on unreadable
      // files.
      void skillMdContent;
      opts.registry.register(record);
      result.loaded += 1;
      opts.logger.info(
        { name: record.name, version: record.version, enabled: record.enabled },
        'skill loaded',
      );
    } catch (e) {
      if (e instanceof SkillManifestError) {
        result.failed.push({ name: entry, error: e.message });
        opts.logger.error({ name: entry, issues: e.issues }, 'skill manifest invalid');
      } else {
        result.failed.push({ name: entry, error: (e as Error).message });
        opts.logger.error({ name: entry, err: (e as Error).message }, 'skill load failed');
      }
    }
  }

  opts.logger.info(
    {
      loaded: result.loaded,
      failed: result.failed.length,
      skipped: result.skipped.length,
    },
    `${result.loaded} skill(s) loaded`,
  );
  return result;
}
