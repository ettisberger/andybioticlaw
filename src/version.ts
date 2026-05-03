import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './config/load.js';

/**
 * Read the service's semver from `package.json` at the project root.
 *
 * Single source of truth — used by `src/skills/loader.ts` (for the
 * skill `core_required` compatibility check) and
 * `src/telegram/status-message.ts` (for the boot notification).
 *
 * Returns `'0.0.0'` if the file is unreadable or the JSON is missing
 * the field — never throws. The fallback is safer than a crash for a
 * boot-time read that's just decorative.
 */
export function readPackageVersion(): string {
  try {
    const raw = readFileSync(resolve(projectRoot(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
