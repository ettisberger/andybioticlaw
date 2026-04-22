import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import { loadManifest, SkillManifestError } from './manifest.js';
import type { SkillRegistry, SkillRecord } from './registry.js';

export interface SkillLoadOptions {
  dir: string;
  logger: Logger;
  registry: SkillRegistry;
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
