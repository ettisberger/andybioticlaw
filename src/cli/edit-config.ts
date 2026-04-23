import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import argon2 from 'argon2';
import { loadConfig, projectRoot } from '../config/load.js';
import { defaultConfigPath, pidFilePath, expandPath } from '../config/paths.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';
import {
  arrowPicker,
  askBoolean,
  askEnum,
  askInteger,
  askLine,
  askSecret,
  releaseStdin,
} from './prompt-helpers.js';

/**
 * Interactive editor for the most-tweaked subset of `config.yaml`.
 *
 * Loops a sub-menu of editable fields. Per pick: prints current value,
 * runs a type-specific prompt, validates, surgically patches the YAML
 * via line-oriented regex (preserves comments + unrelated formatting),
 * then either SIGHUPs the running daemon (hot-reloadable fields) or
 * prints the systemctl-restart hint (restart-required fields).
 *
 * Loops until "Done"; never crashes on cancel — Ctrl-C just returns
 * the user to the picker.
 */

type Stdin = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
};

const MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7  (current flagship — most capable)' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6  (previous Opus generation)' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6  (mid-tier — fast + capable)' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5  (cheapest, fastest)' },
];

const LOG_LEVELS: ReadonlyArray<{ value: string }> = [
  { value: 'debug' },
  { value: 'info' },
  { value: 'warn' },
  { value: 'error' },
];

interface CurrentValues {
  model: string;
  dailyTokenLimit: number;
  perSessionTokenLimit: number;
  autoAccept: boolean;
  retentionDays: number | null;
  logLevel: string;
  conversationHistoryLimit: number;
  allowedUserIds: number[];
  dashboardEnabled: boolean;
  passwordHashSet: boolean;
}

export async function runEditConfigCommand(): Promise<void> {
  const stdin = process.stdin as Stdin;
  const stdout = process.stdout;
  const configPath = defaultConfigPath(projectRoot());

  if (!existsSync(configPath)) {
    stdout.write(
      `\n  ${yellow('!')} ${dim(`config not found at ${configPath} — run 'andybioticlaw init' first.`)}\n\n`,
    );
    return;
  }

  stdout.write(
    `\n${bold(lavender('andybioticlaw'))} ${dim('— edit settings')}\n` +
      dim(`  patches ${configPath} (preserves comments)\n`) +
      dim(`  Ctrl-C / pick "Done" to leave\n\n`),
  );

  try {
    while (true) {
      const cur = readCurrent(configPath);
      const choice = await pickField(stdin, stdout, cur);
      if (choice === null || choice === 'done') {
        stdout.write(`\n${dim('bye.')}\n\n`);
        return;
      }
      try {
        await editOne(stdin, stdout, configPath, choice, cur);
      } catch (e) {
        stdout.write(`\n  ${yellow('!')} ${dim((e as Error).message)}\n`);
      }
    }
  } finally {
    // Pause stdin so the CLI process can exit when this function
    // returns — the prompt helpers resume stdin on entry but never
    // pause it, which would otherwise leave node's event loop alive.
    releaseStdin();
  }
}

// --- field picker -----------------------------------------------------

type FieldKey =
  | 'model'
  | 'dailyTokenLimit'
  | 'perSessionTokenLimit'
  | 'autoAccept'
  | 'retentionDays'
  | 'logLevel'
  | 'conversationHistoryLimit'
  | 'allowedUserIds'
  | 'dashboardEnabled'
  | 'passwordHash';

async function pickField(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  cur: CurrentValues,
): Promise<FieldKey | 'done' | null> {
  const fields: Array<{
    key: FieldKey | 'done';
    label: string;
    current: string;
    restart?: boolean;
  }> = [
    { key: 'model', label: 'Agent model', current: cur.model, restart: true },
    {
      key: 'dailyTokenLimit',
      label: 'Daily token budget',
      current: cur.dailyTokenLimit.toLocaleString(),
    },
    {
      key: 'perSessionTokenLimit',
      label: 'Per-session token limit',
      current: cur.perSessionTokenLimit.toLocaleString(),
    },
    { key: 'autoAccept', label: 'Memory auto-accept', current: cur.autoAccept ? 'ON' : 'OFF' },
    {
      key: 'retentionDays',
      label: 'Message retention days',
      current: cur.retentionDays === null ? 'forever' : `${cur.retentionDays} days`,
    },
    { key: 'logLevel', label: 'Log level', current: cur.logLevel },
    {
      key: 'conversationHistoryLimit',
      label: 'Conversation history limit',
      current: `${cur.conversationHistoryLimit} msgs`,
    },
    {
      key: 'allowedUserIds',
      label: 'Allowed Telegram users',
      current:
        cur.allowedUserIds.length === 0
          ? '(none — bot will reject all DMs)'
          : `${cur.allowedUserIds.length}: ${cur.allowedUserIds.join(', ')}`,
      restart: true,
    },
    {
      key: 'dashboardEnabled',
      label: 'Dashboard (web UI)',
      current: cur.dashboardEnabled ? 'ON' : 'OFF',
      restart: true,
    },
    {
      key: 'passwordHash',
      label: 'Dashboard password',
      current: cur.passwordHashSet ? 'set' : 'not set',
      restart: true,
    },
    { key: 'done', label: 'Done — back to shell', current: '' },
  ];

  const idx = await arrowPicker(stdin, stdout, {
    title: 'Edit settings',
    helpLine: '↑/↓ move · Enter select · q quit',
    items: fields.map((f) => ({
      label: f.label,
      meta: f.current,
      tag: f.key === 'done' ? '' : f.restart ? ' (restart)' : ' (live)',
    })),
  });
  if (idx < 0) return null;
  return fields[idx]!.key;
}

// --- per-field edit dispatch -----------------------------------------

async function editOne(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  key: FieldKey,
  cur: CurrentValues,
): Promise<void> {
  switch (key) {
    case 'model':
      await editEnum(
        stdin,
        stdout,
        configPath,
        'agent.model',
        cur.model,
        MODELS,
        /^(\s+model:\s*).*$/m,
        true, // restart
      );
      return;
    case 'dailyTokenLimit':
      await editInteger(
        stdin,
        stdout,
        configPath,
        'budget.dailyTokenLimit',
        cur.dailyTokenLimit,
        /^(\s+dailyTokenLimit:\s*)\d+\s*$/m,
        { min: 0 },
        false,
      );
      return;
    case 'perSessionTokenLimit':
      await editInteger(
        stdin,
        stdout,
        configPath,
        'budget.perSessionTokenLimit',
        cur.perSessionTokenLimit,
        /^(\s+perSessionTokenLimit:\s*)\d+\s*$/m,
        { min: 0 },
        false,
      );
      return;
    case 'autoAccept':
      await editBoolean(
        stdin,
        stdout,
        configPath,
        'memory.autoAccept',
        cur.autoAccept,
        /^(\s+autoAccept:\s*)(true|false)\s*$/m,
        false,
      );
      return;
    case 'retentionDays':
      await editIntegerOrNull(
        stdin,
        stdout,
        configPath,
        'messages.retentionDays',
        cur.retentionDays,
        /^(\s+retentionDays:\s*)(null|\d+)\s*$/m,
        { min: 1 },
        false,
      );
      return;
    case 'logLevel':
      await editEnum(
        stdin,
        stdout,
        configPath,
        'service.logLevel',
        cur.logLevel,
        LOG_LEVELS,
        /^(\s+logLevel:\s*)\w+\s*$/m,
        false,
      );
      return;
    case 'conversationHistoryLimit':
      await editInteger(
        stdin,
        stdout,
        configPath,
        'telegram.conversationHistoryLimit',
        cur.conversationHistoryLimit,
        /^(\s+conversationHistoryLimit:\s*)\d+\s*$/m,
        { min: 0, max: 500 },
        false,
      );
      return;
    case 'allowedUserIds':
      await editAllowedUsers(stdin, stdout, configPath, cur.allowedUserIds);
      return;
    case 'dashboardEnabled':
      await editBoolean(
        stdin,
        stdout,
        configPath,
        'dashboard.enabled',
        cur.dashboardEnabled,
        // Targets the 2-space-indented `enabled:` line that immediately
        // follows `dashboard:` — deliberately anchored to the top-level
        // key so it can't match `dashboard.basicAuth.enabled` (4-space
        // indent, further down).
        /^(dashboard:\s*\n  enabled:\s*)(true|false)\s*$/m,
        true, // restart (Fastify binds the HTTP listener at boot)
      );
      return;
    case 'passwordHash':
      await editPassword(stdin, stdout, configPath);
      return;
  }
}

// --- generic editors --------------------------------------------------

async function editEnum(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  pathLabel: string,
  current: string,
  options: ReadonlyArray<{ value: string; label?: string }>,
  regex: RegExp,
  restart: boolean,
): Promise<void> {
  stdout.write(`\n  ${dim('current:')} ${cyan(current)}\n\n`);
  const next = await askEnum(
    stdin,
    stdout,
    `  ${lavender('?')} new value (number or full name, Enter = keep): `,
    options,
    { default: current },
  );
  if (next === null || next === current) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  patchAndAnnounce(configPath, regex, `$1${next}`, pathLabel, current, next, restart, stdout);
}

async function editInteger(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  pathLabel: string,
  current: number,
  regex: RegExp,
  bounds: { min?: number; max?: number },
  restart: boolean,
): Promise<void> {
  stdout.write(`\n  ${dim('current:')} ${cyan(current.toLocaleString())}\n\n`);
  const next = await askInteger(
    stdin,
    stdout,
    `  ${lavender('?')} new value (Enter = keep): `,
    { ...bounds, default: current },
  );
  if (next === null || next === 'aborted' || next === current) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  patchAndAnnounce(
    configPath,
    regex,
    `$1${next}`,
    pathLabel,
    current.toLocaleString(),
    next.toLocaleString(),
    restart,
    stdout,
  );
}

async function editIntegerOrNull(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  pathLabel: string,
  current: number | null,
  regex: RegExp,
  bounds: { min?: number; max?: number },
  restart: boolean,
): Promise<void> {
  const curStr = current === null ? 'forever' : `${current}`;
  stdout.write(`\n  ${dim('current:')} ${cyan(curStr)}\n`);
  stdout.write(
    `  ${dim('Enter')} ${cyan('null')} ${dim('or')} ${cyan('none')} ${dim('to keep messages forever; positive integer = days.')}\n\n`,
  );
  const next = await askInteger(
    stdin,
    stdout,
    `  ${lavender('?')} new value (Enter = keep): `,
    { ...bounds, allowNull: true },
  );
  if (next === 'aborted') {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  if (next === current) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  const replacement = `$1${next === null ? 'null' : next}`;
  const nextStr = next === null ? 'forever' : `${next} days`;
  patchAndAnnounce(configPath, regex, replacement, pathLabel, curStr, nextStr, restart, stdout);
}

async function editBoolean(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  pathLabel: string,
  current: boolean,
  regex: RegExp,
  restart: boolean,
): Promise<void> {
  stdout.write(`\n  ${dim('current:')} ${cyan(current ? 'ON' : 'OFF')}\n\n`);
  const next = await askBoolean(
    stdin,
    stdout,
    `  ${lavender('?')} new value (y/n, Enter = keep): `,
    { default: current },
  );
  if (next === null || next === current) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  patchAndAnnounce(
    configPath,
    regex,
    `$1${next}`,
    pathLabel,
    current ? 'ON' : 'OFF',
    next ? 'ON' : 'OFF',
    restart,
    stdout,
  );
}

async function editAllowedUsers(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  current: number[],
): Promise<void> {
  let working = [...current];
  while (true) {
    stdout.write(
      `\n  ${dim('current:')} ${cyan(working.length === 0 ? '(none)' : working.join(', '))}\n` +
        `  ${dim('a = add, r = remove, d = done')}\n`,
    );
    const raw = await askLine(stdin, stdout, `  ${lavender('?')} action: `);
    if (raw === null) return;
    const c = raw.trim().toLowerCase();
    if (c === 'd' || c === 'done') break;
    if (c === 'a' || c === 'add') {
      const id = await askInteger(stdin, stdout, `  ${lavender('?')} user id to add: `, {
        min: 1,
      });
      if (id === null || id === 'aborted') continue;
      if (working.includes(id)) {
        stdout.write(`  ${yellow('!')} ${dim('already in list')}\n`);
        continue;
      }
      working.push(id);
    } else if (c === 'r' || c === 'remove') {
      if (working.length === 0) {
        stdout.write(`  ${yellow('!')} ${dim('list is already empty')}\n`);
        continue;
      }
      const id = await askInteger(stdin, stdout, `  ${lavender('?')} user id to remove: `, {
        min: 1,
      });
      if (id === null || id === 'aborted') continue;
      const idx = working.indexOf(id);
      if (idx < 0) {
        stdout.write(`  ${yellow('!')} ${dim(`${id} not in list`)}\n`);
        continue;
      }
      working.splice(idx, 1);
    } else {
      stdout.write(`  ${yellow('!')} ${dim('use a, r or d')}\n`);
    }
  }

  if (sameNumberArray(working, current)) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  patchAndAnnounce(
    configPath,
    /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
    `$1[${working.join(', ')}]`,
    'telegram.dm.allowedUserIds',
    current.length === 0 ? '[]' : `[${current.join(', ')}]`,
    working.length === 0 ? '[]' : `[${working.join(', ')}]`,
    true, // restart
    stdout,
  );
}

async function editPassword(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
): Promise<void> {
  stdout.write(
    `\n  ${dim('Enter a new dashboard password (Enter on empty = keep current).')}\n\n`,
  );
  const pwd = await askSecret(stdin, stdout, `  ${lavender('?')} new password: `);
  if (pwd === null) return;
  if (pwd.trim().length === 0) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  stdout.write(`  ${dim('hashing with argon2id…')}\n`);
  const hash = await argon2.hash(pwd, { type: argon2.argon2id });
  patchAndAnnounce(
    configPath,
    /^(\s+passwordHash:\s*).*$/m,
    `$1'${hash}'`,
    'dashboard.basicAuth.passwordHash',
    'old hash',
    'new hash',
    true, // restart (Fastify reads the hash at boot)
    stdout,
  );
}

// --- patch + reload-hint ---------------------------------------------

function patchAndAnnounce(
  configPath: string,
  regex: RegExp,
  replacement: string,
  pathLabel: string,
  before: string,
  after: string,
  restart: boolean,
  stdout: NodeJS.WritableStream,
): void {
  const body = readFileSync(configPath, 'utf8');
  const next = body.replace(regex, replacement);
  if (next === body) {
    stdout.write(
      `  ${yellow('!')} ${dim(`could not patch ${pathLabel} — line not found in config.yaml. Edit manually.`)}\n\n`,
    );
    return;
  }
  writeFileSync(configPath, next);

  // Validate post-patch — if Zod rejects, alert loudly so operator knows.
  let validationOk = true;
  try {
    loadConfig();
  } catch (e) {
    validationOk = false;
    stdout.write(
      `  ${yellow('⚠')} ${dim(`config validation failed after patch: ${(e as Error).message}`)}\n`,
    );
  }

  stdout.write(
    `  ${sage('✓')} ${green('updated')} ${cyan(pathLabel)}: ${dim(before)} ${dim('→')} ${cyan(after)}\n`,
  );

  if (!validationOk) {
    stdout.write(
      `  ${yellow('!')} ${dim(`re-edit or rollback config.yaml manually before restarting.`)}\n\n`,
    );
    return;
  }

  if (restart) {
    stdout.write(
      `  ${yellow('⚠')} ${dim('restart required to apply:')}\n` +
        `      ${cyan('sudo systemctl restart andybioticlaw')}\n\n`,
    );
  } else {
    sendSighupIfRunning(stdout);
    stdout.write('\n');
  }
}

/**
 * SIGHUP the running daemon if its pidfile points to a live process.
 * Self-contained copy of admin.ts:sendSighupIfRunning so we don't have
 * to import from the CLI entrypoint module.
 */
function sendSighupIfRunning(stdout: NodeJS.WritableStream): void {
  // Resolve dataDir from the live config (could differ from default).
  let dataDir: string;
  try {
    const loaded = loadConfig();
    dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
  } catch {
    return;
  }
  const pidPath = pidFilePath(dataDir);
  if (!existsSync(pidPath)) {
    stdout.write(
      `  ${dim('(no running daemon detected — change will take effect on next start)')}\n`,
    );
    return;
  }
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) return;
  try {
    process.kill(pid, 'SIGHUP');
    stdout.write(
      `  ${sage('✓')} ${green('live-reloaded')} ${dim(`(SIGHUP sent to daemon pid ${pid})`)}\n`,
    );
  } catch {
    stdout.write(
      `  ${dim('(daemon pidfile present but process not reachable — restart to apply)')}\n`,
    );
  }
}

// --- config.yaml line readers -----------------------------------------

function readCurrent(configPath: string): CurrentValues {
  const body = readFileSync(configPath, 'utf8');
  return {
    model: matchOrDefault(body, /^\s+model:\s*(\S+)\s*$/m, 'claude-opus-4-7'),
    dailyTokenLimit: matchInt(body, /^\s+dailyTokenLimit:\s*(\d+)\s*$/m, 2_000_000),
    perSessionTokenLimit: matchInt(
      body,
      /^\s+perSessionTokenLimit:\s*(\d+)\s*$/m,
      200_000,
    ),
    autoAccept: matchBool(body, /^\s+autoAccept:\s*(true|false)\s*$/m, true),
    retentionDays: matchIntOrNull(body, /^\s+retentionDays:\s*(null|\d+)\s*$/m),
    logLevel: matchOrDefault(body, /^\s+logLevel:\s*(\w+)\s*$/m, 'info'),
    conversationHistoryLimit: matchInt(
      body,
      /^\s+conversationHistoryLimit:\s*(\d+)\s*$/m,
      50,
    ),
    allowedUserIds: matchAllowedUserIds(body),
    dashboardEnabled: matchBool(
      body,
      // Same two-line anchor as the patch regex — see editOne dispatch.
      /^dashboard:\s*\n  enabled:\s*(true|false)\s*$/m,
      false,
    ),
    passwordHashSet: /^\s+passwordHash:\s*['"][^'"]+['"]\s*$/m.test(body),
  };
}

function matchOrDefault(body: string, re: RegExp, dflt: string): string {
  const m = body.match(re);
  return m && m[1] !== undefined ? m[1] : dflt;
}

function matchInt(body: string, re: RegExp, dflt: number): number {
  const m = body.match(re);
  if (!m || m[1] === undefined) return dflt;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : dflt;
}

function matchBool(body: string, re: RegExp, dflt: boolean): boolean {
  const m = body.match(re);
  if (!m || m[1] === undefined) return dflt;
  return m[1] === 'true';
}

function matchIntOrNull(body: string, re: RegExp): number | null {
  const m = body.match(re);
  if (!m || m[1] === undefined) return null;
  if (m[1] === 'null') return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

function matchAllowedUserIds(body: string): number[] {
  const m = body.match(/^\s+allowedUserIds:\s*\[(.*?)\]/m);
  if (!m || m[1] === undefined) return [];
  const inside = m[1].trim();
  if (!inside) return [];
  return inside
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function sameNumberArray(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aS = [...a].sort((x, y) => x - y);
  const bS = [...b].sort((x, y) => x - y);
  return aS.every((v, i) => v === bS[i]);
}
