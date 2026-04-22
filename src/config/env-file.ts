import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

/**
 * Tiny dotenv reader/writer that preserves comments and ordering.
 *
 * Used by the skill-setup wizard to update `.env` without clobbering
 * the surrounding formatting. Not a general dotenv clone — no `export`
 * support, no multi-line values, no variable expansion. That matches
 * the minimal loader in src/config/load.ts.
 */

export interface EnvFile {
  /** Parsed key → value (de-quoted). */
  values: Record<string, string>;
  /** Raw lines (retained verbatim for round-trip write). */
  lines: string[];
}

export function readEnvFile(path: string): EnvFile {
  if (!existsSync(path)) return { values: {}, lines: [] };
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  // The trailing newline of the file produces a final empty element
  // in `split`. Drop it so we don't append an extra blank every write.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const values: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
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
    values[key] = value;
  }

  return { values, lines };
}

/**
 * Write (or overwrite) one or more keys in an env file.
 *
 * For each key:
 *   - If it already appears in `lines`, the existing line is replaced
 *     in place (preserving surrounding comments / formatting).
 *   - If it doesn't appear, it's appended at the end. Values needing
 *     quoting (whitespace, special chars) get double-quoted.
 *
 * The file's existing trailing-newline posture is respected: files
 * always end with a newline after the write. Mode set to 0600 on write
 * — these are secrets.
 */
export function writeEnvFileUpdates(
  path: string,
  updates: Record<string, string>,
): { updated: string[]; appended: string[] } {
  const ef = readEnvFile(path);
  const updated: string[] = [];
  const appended: string[] = [];

  const keysToWrite = Object.entries(updates);

  for (const [key, value] of keysToWrite) {
    const serialized = serializeLine(key, value);
    const idx = ef.lines.findIndex((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      const eq = line.indexOf('=');
      if (eq < 0) return false;
      return line.slice(0, eq).trim() === key;
    });
    if (idx >= 0) {
      ef.lines[idx] = serialized;
      updated.push(key);
    } else {
      ef.lines.push(serialized);
      appended.push(key);
    }
  }

  writeFileSync(path, ef.lines.join('\n') + '\n', { mode: 0o600 });
  // `mode` in writeFileSync only applies on file CREATION. If .env
  // already existed with looser perms, that's what the OS keeps unless
  // we chmod explicitly. These are secrets — we always want 0600.
  try {
    chmodSync(path, 0o600);
  } catch {
    // non-fatal (e.g. unsupported on some filesystems)
  }
  return { updated, appended };
}

function serializeLine(key: string, value: string): string {
  // Quote the value if it contains whitespace, quotes, or a leading `#`.
  const needsQuoting =
    value.length === 0 ||
    /[\s"'#\\]/.test(value) ||
    value.startsWith('#');
  const rendered = needsQuoting
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
  return `${key}=${rendered}`;
}
