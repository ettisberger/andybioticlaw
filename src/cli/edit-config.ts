import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import argon2 from 'argon2';
import { loadConfig, projectRoot } from '../config/load.js';
import {
  defaultConfigPath,
  defaultEnvPath,
  expandPath,
  pidFilePath,
  sqliteDbPath,
} from '../config/paths.js';
import { bold, cyan, dim, green, lavender, sage, yellow } from './ansi.js';
import {
  arrowPicker,
  askInteger,
  askLine,
  askSecret,
  releaseStdin,
} from './prompt-helpers.js';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';
import { openDatabase } from '../db/index.js';
import { createVoiceStateRepo } from '../db/repositories/voice-state.js';
import { transcribeWithGroq } from '../telegram/voice.js';
import type { PickerItem } from './prompt-helpers.js';

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
  dashboardAuthEnabled: boolean;
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
    `\n${bold(lavender('andybioticlaw'))} ${dim('— Settings')}\n` +
      dim(`  toggle booleans in place · Enter a value row to edit\n`) +
      dim(`  Ctrl-C / q to exit\n`),
  );

  // Open SQLite + .env once so voice_state toggles + key reads are fast
  // and consistent across redraws.
  const loaded = loadConfig();
  const dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
  const logger = pino({ level: 'warn' });
  const dbHandle = openDatabase(sqliteDbPath(dataDir), logger);
  const voiceState = createVoiceStateRepo(dbHandle.db);
  const envPath = defaultEnvPath(projectRoot());

  // Track restart-tagged changes made in THIS session so we can show a
  // persistent "⚠ restart required" footer. A "session" here is one
  // run of runEditConfigCommand — the counter resets between menu
  // entries, which is the right mental model (the banner reminds you
  // of changes you just made, not historical ones).
  let restartPending = 0;
  const markRestart = () => {
    restartPending += 1;
  };

  try {
    // Build the settings descriptors once per iteration — each descriptor
    // owns its own "read current value" and "flip / edit" callbacks so
    // the outer picker is pure rendering. `rows` is rebuilt inside the
    // items thunk on every redraw to pick up new state after a toggle.
    const describe = (): Setting[] =>
      buildSettings({
        configPath,
        envPath,
        cur: readCurrent(configPath),
        envValues: readEnvFile(envPath).values,
        voiceEnabled: voiceState.getEnabled(),
        stdin,
        stdout,
        voiceState,
      });

    // Pump the picker until the operator hits q. Non-toggle rows resolve
    // the picker with their index; we route to the descriptor's `edit`.
    // After each edit we loop back and re-enter the picker.
    while (true) {
      const snapshotRows = describe();
      const idx = await arrowPicker(stdin, stdout, {
        title: 'Settings',
        helpLine: '↑/↓ move · Enter toggle or edit · q back',
        items: () => toPickerItems(describe()),
        footer: () =>
          restartPending > 0
            ? yellow(
                `⚠ restart required — ${restartPending} change${
                  restartPending === 1 ? '' : 's'
                } pending — ${cyan('sudo systemctl restart andybioticlaw')}`,
              )
            : undefined,
        onToggle: async (i) => {
          const row = describe()[i];
          if (row && row.kind === 'boolean') {
            await row.flip();
            if (row.restart) markRestart();
          }
        },
      });
      if (idx < 0) {
        stdout.write(`\n${dim('bye.')}\n\n`);
        return;
      }
      const row = snapshotRows[idx];
      if (!row) continue;
      if (row.kind === 'boolean') {
        // Shouldn't happen — toggles are handled by onToggle. Defensive.
        continue;
      }
      try {
        await row.edit();
        if (row.restart) markRestart();
      } catch (e) {
        stdout.write(`\n  ${yellow('!')} ${dim((e as Error).message)}\n`);
      }
    }
  } finally {
    dbHandle.close();
    releaseStdin();
  }
}

// --- descriptor-driven settings list ----------------------------------

interface SettingBase {
  key: string;
  section: string;
  label: string;
  /** Whether flipping or editing this requires `systemctl restart`. */
  restart: boolean;
}

interface BooleanSetting extends SettingBase {
  kind: 'boolean';
  checked: boolean;
  flip: () => void | Promise<void>;
}

interface ValueSetting extends SettingBase {
  kind: 'value';
  /** Rendered in the meta column (current value or `not set`). */
  value: string;
  edit: () => Promise<void>;
}

type Setting = BooleanSetting | ValueSetting;

interface BuildSettingsInput {
  configPath: string;
  envPath: string;
  cur: CurrentValues;
  envValues: Record<string, string>;
  voiceEnabled: boolean;
  stdin: Stdin;
  stdout: NodeJS.WritableStream;
  voiceState: ReturnType<typeof createVoiceStateRepo>;
}

function buildSettings(input: BuildSettingsInput): Setting[] {
  const { configPath, envPath, cur, envValues, voiceEnabled, stdin, stdout, voiceState } = input;
  const groqKey = envValues.GROQ_API_KEY?.trim() ?? '';
  const hasGroqKey = groqKey !== '';

  return [
    // -- General --
    {
      key: 'autoAccept',
      section: 'General',
      kind: 'boolean',
      label: 'Memory auto-accept',
      checked: cur.autoAccept,
      restart: false,
      async flip() {
        await editBooleanSilent(
          configPath,
          cur.autoAccept,
          /^(\s+autoAccept:\s*)(true|false)\s*$/m,
          'memory.autoAccept',
          false,
          stdout,
        );
      },
    },
    // -- Agent --
    {
      key: 'model',
      section: 'Agent',
      kind: 'value',
      label: 'Model',
      value: cur.model,
      restart: true,
      async edit() {
        await editEnum(
          stdin,
          stdout,
          configPath,
          'agent.model',
          cur.model,
          MODELS,
          /^(\s+model:\s*).*$/m,
          true,
        );
      },
    },
    {
      key: 'logLevel',
      section: 'Agent',
      kind: 'value',
      label: 'Log level',
      value: cur.logLevel,
      restart: false,
      async edit() {
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
      },
    },
    {
      key: 'conversationHistoryLimit',
      section: 'Agent',
      kind: 'value',
      label: 'Conversation history',
      value: `${cur.conversationHistoryLimit} msgs`,
      restart: false,
      async edit() {
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
      },
    },
    // -- Budget --
    {
      key: 'dailyTokenLimit',
      section: 'Budget',
      kind: 'value',
      label: 'Daily token budget',
      value: cur.dailyTokenLimit.toLocaleString(),
      restart: false,
      async edit() {
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
      },
    },
    {
      key: 'perSessionTokenLimit',
      section: 'Budget',
      kind: 'value',
      label: 'Per-session limit',
      value: cur.perSessionTokenLimit.toLocaleString(),
      restart: false,
      async edit() {
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
      },
    },
    {
      key: 'retentionDays',
      section: 'Budget',
      kind: 'value',
      label: 'Message retention',
      value: cur.retentionDays === null ? 'forever' : `${cur.retentionDays} days`,
      restart: false,
      async edit() {
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
      },
    },
    // -- Telegram --
    {
      key: 'allowedUserIds',
      section: 'Telegram',
      kind: 'value',
      label: 'Allowed users',
      value:
        cur.allowedUserIds.length === 0
          ? '(none — bot rejects all DMs)'
          : `${cur.allowedUserIds.length}: ${cur.allowedUserIds.join(', ')}`,
      restart: true,
      async edit() {
        await editAllowedUsers(stdin, stdout, configPath, cur.allowedUserIds);
      },
    },
    // -- Dashboard --
    {
      key: 'dashboardEnabled',
      section: 'Dashboard',
      kind: 'boolean',
      label: 'Dashboard (web UI)',
      checked: cur.dashboardEnabled,
      restart: true,
      async flip() {
        await editBooleanSilent(
          configPath,
          cur.dashboardEnabled,
          /^(dashboard:\s*\n  enabled:\s*)(true|false)\s*$/m,
          'dashboard.enabled',
          true,
          stdout,
        );
      },
    },
    {
      key: 'dashboardAuthEnabled',
      section: 'Dashboard',
      kind: 'boolean',
      label: 'Basic-auth protection',
      checked: cur.dashboardAuthEnabled,
      restart: true,
      async flip() {
        await editBooleanSilent(
          configPath,
          cur.dashboardAuthEnabled,
          /^(  basicAuth:\s*\n    enabled:\s*)(true|false)\s*$/m,
          'dashboard.basicAuth.enabled',
          true,
          stdout,
        );
      },
    },
    {
      key: 'passwordHash',
      section: 'Dashboard',
      kind: 'value',
      label: 'Dashboard password',
      value: cur.passwordHashSet ? '•••••• (set)' : 'not set',
      restart: true,
      async edit() {
        await editPassword(stdin, stdout, configPath);
      },
    },
    // -- Voice input --
    {
      key: 'voiceEnabled',
      section: 'Voice input',
      kind: 'boolean',
      label: 'Voice input',
      checked: voiceEnabled,
      restart: false,
      flip() {
        if (!voiceEnabled && !hasGroqKey) {
          stdout.write(
            `\n  ${yellow('!')} ${dim('set the Groq API key first, then enable.')}\n`,
          );
          return;
        }
        voiceState.setEnabled(!voiceEnabled);
      },
    },
    {
      key: 'groqKey',
      section: 'Voice input',
      kind: 'value',
      label: 'Groq API key',
      value: hasGroqKey ? maskKey(groqKey) : 'not set',
      restart: true,
      async edit() {
        await editGroqKey(stdin, stdout, envPath, hasGroqKey, voiceState);
      },
    },
    {
      key: 'voiceTest',
      section: 'Voice input',
      kind: 'value',
      label: 'Test transcription…',
      value: hasGroqKey ? '(upload a local audio file)' : '(set API key first)',
      restart: false,
      async edit() {
        if (!hasGroqKey) {
          stdout.write(
            `\n  ${yellow('!')} ${dim('no Groq API key set — configure it first.')}\n`,
          );
          return;
        }
        await runVoiceTest(stdin, stdout, groqKey);
      },
    },
  ];
}

function toPickerItems(settings: Setting[]): PickerItem[] {
  const items: PickerItem[] = [];
  let lastSection = '';
  for (const s of settings) {
    if (s.section !== lastSection) {
      items.push({ kind: 'header', label: s.section });
      lastSection = s.section;
    }
    const tag = s.restart ? yellow('restart') : green('live');
    if (s.kind === 'boolean') {
      items.push({ label: s.label, checked: s.checked, tag });
    } else {
      items.push({ label: s.label, meta: s.value, tag });
    }
  }
  return items;
}

function maskKey(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 6)}${'•'.repeat(6)}${key.slice(-4)}`;
}

async function editBooleanSilent(
  configPath: string,
  current: boolean,
  regex: RegExp,
  pathLabel: string,
  restart: boolean,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  // In the new unified picker booleans flip in place — no sub-picker,
  // no confirmation. This helper just applies the patch + prints the
  // one-line "✓ updated" status. The caller's redraw picks up the new
  // value on the next tick.
  const next = !current;
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

async function editGroqKey(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  envPath: string,
  hasKey: boolean,
  voiceState: ReturnType<typeof createVoiceStateRepo>,
): Promise<void> {
  // Sub-picker so the operator can explicitly choose "remove" — we
  // don't want Enter on the row to open a destructive unset flow.
  const actionIdx = await arrowPicker(stdin, stdout, {
    title: 'Groq API key',
    helpLine: '↑/↓ move · Enter select · q cancel',
    items: [
      { label: hasKey ? 'Update key' : 'Set key' },
      ...(hasKey ? [{ label: 'Remove key' }] : []),
      { label: 'Cancel' },
    ],
  });
  if (actionIdx < 0) return;
  if (hasKey && actionIdx === 1) {
    writeEnvFileUpdates(envPath, { GROQ_API_KEY: '' });
    voiceState.setEnabled(false);
    stdout.write(
      `\n  ${sage('✓')} ${dim('key cleared + voice disabled.')} ` +
        `${yellow('⚠ restart required')} ${dim('to purge it from process env.')}\n`,
    );
    return;
  }
  if ((hasKey && actionIdx === 2) || (!hasKey && actionIdx === 1)) {
    return; // Cancel
  }
  // Set or update.
  const value = await askSecret(
    stdin,
    stdout,
    `\n  ${lavender('?')} Groq API key${dim(' (hidden input):')} `,
  );
  if (value === null) return;
  const trimmed = value.trim();
  if (!trimmed) {
    stdout.write(`\n  ${dim('(empty — no change)')}\n`);
    return;
  }
  writeEnvFileUpdates(envPath, { GROQ_API_KEY: trimmed });
  stdout.write(
    `\n  ${sage('✓')} ${dim('key saved to .env.')} ${yellow('⚠ restart required')} ${dim('to pick it up.')}\n`,
  );
}

async function runVoiceTest(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  apiKey: string,
): Promise<void> {
  const pathInput = await askLine(
    stdin,
    stdout,
    `\n  ${lavender('?')} Path to a local audio file (ogg / mp3 / m4a / wav)${dim(':')} `,
  );
  if (pathInput === null || pathInput.trim() === '') {
    stdout.write(`\n  ${dim('(aborted)')}\n`);
    return;
  }
  const absPath = resolve(pathInput.trim());
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (e) {
    stdout.write(
      `\n  ${yellow('!')} ${dim(`could not read ${absPath}: ${(e as Error).message}`)}\n`,
    );
    return;
  }
  stdout.write(
    `\n  ${dim('▸ uploading')} ${cyan(`${(buf.length / 1024).toFixed(1)} KB`)}${dim(' to Groq…')}\n`,
  );
  try {
    const { text, durationSec } = await transcribeWithGroq(buf, { apiKey });
    if (!text) {
      stdout.write(
        `\n  ${yellow('!')} ${dim('Groq returned no transcript (silent audio?)')}\n`,
      );
      return;
    }
    stdout.write(
      `\n  ${sage('✓')} ${dim('transcript')}${
        durationSec ? dim(` (~${durationSec.toFixed(1)}s audio)`) : ''
      }${dim(':')}\n\n`,
    );
    stdout.write(`  ${text}\n\n`);
  } catch (e) {
    stdout.write(
      `\n  ${yellow('!')} ${dim(`transcription failed: ${(e as Error).message}`)}\n`,
    );
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
  const currentIdx = options.findIndex((o) => o.value === current);
  const idx = await arrowPicker(stdin, stdout, {
    title: `${pathLabel}  ${dim(`(current: ${current})`)}`,
    helpLine: '↑/↓ move · Enter select · q keep current',
    items: options.map((o) => ({
      label: o.label ?? o.value,
      meta: o.value === current ? ' ← current' : '',
    })),
    initialIndex: currentIdx >= 0 ? currentIdx : 0,
  });
  if (idx < 0) {
    stdout.write(`  ${dim('unchanged.')}\n\n`);
    return;
  }
  const next = options[idx]!.value;
  if (next === current) {
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

async function editAllowedUsers(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  configPath: string,
  current: number[],
): Promise<void> {
  const working = [...current];
  let aborted = false;
  while (true) {
    const idx = await arrowPicker(stdin, stdout, {
      title: 'Allowed Telegram users',
      helpLine: '↑/↓ move · Enter select · q cancel (no save)',
      footer:
        working.length === 0
          ? 'current: (none — bot will reject all DMs)'
          : `current: ${working.join(', ')}`,
      items: [
        { label: 'Add user' },
        { label: 'Remove user' },
        { label: 'Done — save changes' },
      ],
    });
    if (idx < 0) {
      aborted = true;
      break;
    }
    if (idx === 2) break; // Done
    if (idx === 0) {
      const id = await askInteger(stdin, stdout, `  ${lavender('?')} user id to add: `, {
        min: 1,
      });
      if (id === null || id === 'aborted') continue;
      if (working.includes(id)) {
        stdout.write(`  ${yellow('!')} ${dim('already in list')}\n`);
        continue;
      }
      working.push(id);
    } else if (idx === 1) {
      if (working.length === 0) {
        stdout.write(`  ${yellow('!')} ${dim('list is already empty')}\n`);
        continue;
      }
      const id = await askInteger(stdin, stdout, `  ${lavender('?')} user id to remove: `, {
        min: 1,
      });
      if (id === null || id === 'aborted') continue;
      const removeIdx = working.indexOf(id);
      if (removeIdx < 0) {
        stdout.write(`  ${yellow('!')} ${dim(`${id} not in list`)}\n`);
        continue;
      }
      working.splice(removeIdx, 1);
    }
  }

  if (aborted) return;

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
    dashboardAuthEnabled: matchBool(
      body,
      /^  basicAuth:\s*\n    enabled:\s*(true|false)\s*$/m,
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
