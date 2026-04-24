import argon2 from 'argon2';
import { cyan, dim, lavender, sage, yellow } from '../ansi.js';
import { arrowPicker, askInteger, askSecret } from '../prompt-helpers.js';
import type { SettingsContext } from './types.js';

/**
 * Shared edit-prompt helpers used by Settings components. Thin wrappers
 * around the lower-level `prompt-helpers.ts` primitives that also apply
 * the "current value → new value" announce in a consistent way.
 *
 * All of these return a typed result indicating whether a change
 * landed, so the caller (the component) can translate that into a
 * `SettingSelectResult`.
 */

export interface EditOutcome<T> {
  /** True iff the user entered a value AND it's different from `current`. */
  changed: boolean;
  /** The new value, or `undefined` if `changed === false`. */
  next?: T;
}

export interface EnumOption {
  value: string;
  label?: string;
}

export async function promptEnum(
  ctx: SettingsContext,
  pathLabel: string,
  current: string,
  options: ReadonlyArray<EnumOption>,
): Promise<EditOutcome<string>> {
  const currentIdx = options.findIndex((o) => o.value === current);
  const idx = await arrowPicker(ctx.stdin, ctx.stdout, {
    title: `${pathLabel}  ${dim(`(current: ${current})`)}`,
    helpLine: '↑/↓ move · Enter select · q keep current',
    items: options.map((o) => ({
      label: o.label ?? o.value,
      meta: o.value === current ? ' ← current' : '',
    })),
    initialIndex: currentIdx >= 0 ? currentIdx : 0,
  });
  if (idx < 0) return { changed: false };
  const next = options[idx]!.value;
  if (next === current) return { changed: false };
  return { changed: true, next };
}

export async function promptInteger(
  ctx: SettingsContext,
  current: number,
  bounds: { min?: number; max?: number },
): Promise<EditOutcome<number>> {
  ctx.stdout.write(`\n  ${dim('current:')} ${cyan(current.toLocaleString())}\n\n`);
  const next = await askInteger(
    ctx.stdin,
    ctx.stdout,
    `  ${lavender('?')} new value (Enter = keep): `,
    { ...bounds, default: current },
  );
  if (next === null || next === 'aborted' || next === current) {
    return { changed: false };
  }
  return { changed: true, next };
}

export async function promptIntegerOrNull(
  ctx: SettingsContext,
  current: number | null,
  bounds: { min?: number; max?: number },
): Promise<EditOutcome<number | null>> {
  const curStr = current === null ? 'forever' : `${current}`;
  ctx.stdout.write(`\n  ${dim('current:')} ${cyan(curStr)}\n`);
  ctx.stdout.write(
    `  ${dim('Enter')} ${cyan('null')} ${dim('or')} ${cyan('none')} ${dim('to keep forever; positive integer = days.')}\n\n`,
  );
  const next = await askInteger(
    ctx.stdin,
    ctx.stdout,
    `  ${lavender('?')} new value (Enter = keep): `,
    { ...bounds, allowNull: true },
  );
  if (next === 'aborted') return { changed: false };
  if (next === current) return { changed: false };
  return { changed: true, next };
}

export async function promptSecret(
  ctx: SettingsContext,
  fieldLabel: string,
): Promise<EditOutcome<string>> {
  const value = await askSecret(
    ctx.stdin,
    ctx.stdout,
    `\n  ${lavender('?')} ${fieldLabel}${dim(' (hidden input):')} `,
  );
  if (value === null) return { changed: false };
  const trimmed = value.trim();
  if (!trimmed) return { changed: false };
  return { changed: true, next: trimmed };
}

/**
 * Argon2id hash of a secret. Matches the hashing previously done inside
 * `editPassword` in edit-config.ts. Exported so the SecretSetting
 * component can take a `transform` callback (identity by default,
 * argon2 for the dashboard password).
 */
export async function hashArgon2(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Sub-menu for editing a list of integers (currently used for
 * `telegram.dm.allowedUserIds`). Loops an arrow-picker with Add /
 * Remove / Done entries. Returns the new list, or `null` if the
 * operator aborted.
 */
export async function promptIntegerList(
  ctx: SettingsContext,
  current: number[],
  title: string,
): Promise<EditOutcome<number[]>> {
  const working = [...current];
  while (true) {
    const idx = await arrowPicker(ctx.stdin, ctx.stdout, {
      title,
      helpLine: '↑/↓ move · Enter select · q cancel (no save)',
      footer:
        working.length === 0
          ? 'current: (none)'
          : `current: ${working.join(', ')}`,
      items: [
        { label: 'Add' },
        { label: 'Remove' },
        { label: 'Done — save changes' },
      ],
    });
    if (idx < 0) return { changed: false };
    if (idx === 2) break;
    if (idx === 0) {
      const id = await askInteger(ctx.stdin, ctx.stdout, `  ${lavender('?')} id to add: `, {
        min: 1,
      });
      if (id === null || id === 'aborted') continue;
      if (working.includes(id)) {
        ctx.stdout.write(`  ${yellow('!')} ${dim('already in list')}\n`);
        continue;
      }
      working.push(id);
    } else {
      if (working.length === 0) {
        ctx.stdout.write(`  ${yellow('!')} ${dim('list is already empty')}\n`);
        continue;
      }
      const id = await askInteger(
        ctx.stdin,
        ctx.stdout,
        `  ${lavender('?')} id to remove: `,
        { min: 1 },
      );
      if (id === null || id === 'aborted') continue;
      const removeIdx = working.indexOf(id);
      if (removeIdx < 0) {
        ctx.stdout.write(`  ${yellow('!')} ${dim(`${id} not in list`)}\n`);
        continue;
      }
      working.splice(removeIdx, 1);
    }
  }

  if (sameNumberArray(working, current)) return { changed: false };
  return { changed: true, next: working };
}

function sameNumberArray(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aS = [...a].sort((x, y) => x - y);
  const bS = [...b].sort((x, y) => x - y);
  return aS.every((v, i) => v === bS[i]);
}

/**
 * Print a short "✓ saved" confirmation to stdout. Called by
 * components after a successful write that didn't go through
 * `patchYaml` (e.g. .env writes, SQLite mutations).
 */
export function announceSaved(ctx: SettingsContext, description: string): void {
  ctx.stdout.write(`\n  ${sage('✓')} ${dim(description)}\n`);
}
