/**
 * Read the browser block from the main config.yaml.
 *
 * The MCP server runs as a subprocess of the Claude CLI which is itself a
 * subprocess of the core service. We don't share state; we just re-parse
 * the YAML config from disk each time we need a fresh view. That keeps
 * the server stateless w.r.t. the parent's runtime and avoids a half-broken
 * "hot reload" story.
 *
 * `hostnameAllowlist` is genuinely hot-reloadable — the recorder re-reads
 * on each tool call so SIGHUP-style config edits during a long session
 * take effect mid-session. Profile list changes need a service restart
 * (see RESTART_REQUIRED_PATHS in src/config/schema.ts).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

export class BrowserConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserConfigError';
  }
}

/**
 * Locate the config file. Honors ANDYBIOTICLAW_CONFIG_PATH (set by
 * src/agent/session.ts in `memoryMcpEnv`); falls back to the standard
 * location relative to the skill folder if missing.
 */
export function resolveConfigPath() {
  if (process.env.ANDYBIOTICLAW_CONFIG_PATH) {
    return process.env.ANDYBIOTICLAW_CONFIG_PATH;
  }
  // skills/browser/mcp-server/src/config.js → ../../../../config/config.yaml
  return resolve(import.meta.dirname, '../../../../config/config.yaml');
}

/**
 * Read + parse + extract the browser block. Returns a normalized shape
 * with all defaults applied (mirroring src/config/schema.ts:BrowserConfig).
 */
export function readBrowserConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new BrowserConfigError(
      `cannot read config at ${configPath}: ${e.message}`,
    );
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new BrowserConfigError(`config YAML parse error: ${e.message}`);
  }
  const block = parsed?.browser ?? {};
  return {
    enabled: block.enabled === true,
    hostnameAllowlist: Array.isArray(block.hostnameAllowlist)
      ? block.hostnameAllowlist.filter((h) => typeof h === 'string')
      : [],
    profiles: Array.isArray(block.profiles)
      ? block.profiles
          .filter((p) => p && typeof p.name === 'string')
          .map((p) => ({
            name: p.name,
            description: typeof p.description === 'string' ? p.description : null,
          }))
      : [],
    defaultProfile:
      typeof block.defaultProfile === 'string' ? block.defaultProfile : null,
    dashboard: {
      enabled: block.dashboard?.enabled !== false,
      retentionDays: Number.isInteger(block.dashboard?.retentionDays)
        ? block.dashboard.retentionDays
        : 7,
      retentionMb: Number.isInteger(block.dashboard?.retentionMb)
        ? block.dashboard.retentionMb
        : 50,
      screenshotOnSnapshot: block.dashboard?.screenshotOnSnapshot === true,
    },
  };
}

/**
 * Derive runtime paths from the service config block. The MCP server
 * needs absolute paths for profile dirs, screenshot dirs, and Chromium
 * binary location — all under the data/ tree that systemd's
 * ReadWritePaths grants.
 */
export function resolveRuntimePaths(configPath) {
  let parsed;
  try {
    parsed = yaml.load(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new BrowserConfigError(
      `cannot derive runtime paths from ${configPath}: ${e.message}`,
    );
  }
  // service.dataDir may be relative — resolve against project root,
  // which is the parent of the config file's directory.
  const rawDataDir = parsed?.service?.dataDir ?? 'data';
  const projectRoot = resolve(dirname(configPath), '..');
  const dataDir = resolve(projectRoot, rawDataDir);
  return {
    dataDir,
    profilesDir: resolve(dataDir, 'browser/profiles'),
    screenshotsDir: resolve(dataDir, 'browser/screenshots'),
    browsersPath: resolve(dataDir, 'cache/playwright'),
  };
}
