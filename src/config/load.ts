import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { Config } from './schema.js';
import type { Config as ConfigType } from './schema.js';
import { defaultConfigPath, defaultEnvPath, expandPath } from './paths.js';

export interface LoadResult {
  config: ConfigType;
  configPath: string;
  rawYaml: string;
}

export interface LoadError {
  kind: 'file-missing' | 'yaml-parse' | 'validation';
  message: string;
  detail?: unknown;
}

export class ConfigLoadError extends Error {
  readonly kind: LoadError['kind'];
  readonly detail?: unknown;

  constructor(err: LoadError) {
    super(err.message);
    this.name = 'ConfigLoadError';
    this.kind = err.kind;
    this.detail = err.detail;
  }
}

/**
 * Loads environment variables from a `.env` file into `process.env` if the
 * file exists. Keeps existing `process.env` values (so systemd-provided env
 * wins over the file). Minimal parser — no `export` keyword, no shell
 * interpolation, no multi-line values. For richer behavior switch to dotenv.
 */
export function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Absolute path to the repo root — derived from THIS module's own file
 * location, not `process.cwd()`. The previous cwd-based implementation
 * broke the admin CLI when invoked by Emma's Bash tool (Emma's cwd is
 * `data/workspaces/dm/`, so `cwd()/config/config.yaml` didn't exist).
 *
 * Layout assumption: `config/load.{ts,js}` lives two directories below
 * the repo root in both `src/` and `dist/` — true today for both the
 * tsx dev path and the compiled `dist/` path.
 */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function loadConfig(overridePath?: string): LoadResult {
  const configPath = overridePath ? expandPath(overridePath) : defaultConfigPath(projectRoot());

  if (!existsSync(configPath)) {
    throw new ConfigLoadError({
      kind: 'file-missing',
      message: `config file not found: ${configPath}\n  Hint: copy config/config.example.yaml to ${configPath} and edit to taste.`,
    });
  }

  const rawYaml = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml);
  } catch (e) {
    throw new ConfigLoadError({
      kind: 'yaml-parse',
      message: `failed to parse YAML in ${configPath}: ${(e as Error).message}`,
      detail: e,
    });
  }

  const result = Config.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigLoadError({
      kind: 'validation',
      message: `config validation failed for ${configPath}:\n${issues}`,
      detail: result.error,
    });
  }

  return { config: result.data, configPath, rawYaml };
}

/**
 * Convenience: load `.env` from the default location before loading config.
 */
export function bootstrapEnv(): void {
  loadEnvFile(defaultEnvPath(projectRoot()));
}
