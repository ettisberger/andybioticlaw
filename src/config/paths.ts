import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';

/**
 * Expands a leading `~` / `~/` to the current user's home directory and
 * resolves the path to an absolute path relative to `baseDir` (default: CWD).
 */
export function expandPath(input: string, baseDir: string = process.cwd()): string {
  if (!input) return input;

  let expanded = input;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = `${homedir()}/${expanded.slice(2)}`;

  if (isAbsolute(expanded)) return expanded;
  return resolve(baseDir, expanded);
}

/**
 * Default locations the service looks up when no override is provided.
 * `CONFIG_PATH` env var takes precedence if set.
 */
export function defaultConfigPath(projectRoot: string): string {
  if (process.env.CONFIG_PATH) return expandPath(process.env.CONFIG_PATH);
  return resolve(projectRoot, 'config', 'config.yaml');
}

export function defaultEnvPath(projectRoot: string): string {
  return resolve(projectRoot, '.env');
}

export function pidFilePath(dataDir: string): string {
  return resolve(dataDir, 'andybioticlaw.pid');
}

export function sqliteDbPath(dataDir: string): string {
  return resolve(dataDir, 'andybioticlaw.db');
}

export function logsDir(dataDir: string): string {
  return resolve(dataDir, 'logs');
}

export function backupsDir(dataDir: string): string {
  return resolve(dataDir, 'backups');
}

export function workspacesDir(dataDir: string): string {
  return resolve(dataDir, 'workspaces');
}
