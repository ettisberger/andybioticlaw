import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cyan, dim, lavender, sage, yellow } from '../ansi.js';
import { askLine } from '../prompt-helpers.js';
import { transcribeWithGroq } from '../../telegram/voice.js';
import { ActionSetting } from './components/action-setting.js';
import { BooleanSetting } from './components/boolean-setting.js';
import { EnumSetting } from './components/enum-setting.js';
import { IntegerSetting } from './components/integer-setting.js';
import { IntegerOrNullSetting } from './components/integer-or-null-setting.js';
import { ListSetting } from './components/list-setting.js';
import { SecretSetting, hashArgon2 } from './components/secret-setting.js';
import {
  matchBool,
  matchInt,
  matchIntList,
  matchIntOrNull,
  matchString,
  passwordHashIsSet,
} from './yaml.js';
import type { SettingComponent, SettingsContext } from './types.js';

/**
 * Assemble the full Map<id, SettingComponent> used by the Settings
 * menu. Every setting declared in `layout.ts` MUST have an entry
 * here. Unknown ids in the layout are silently skipped by the
 * renderer — that's the only forgiving part; this function should be
 * exhaustive.
 *
 * Grouped loosely by section for readability.
 */
export function buildSettingsRegistry(): Map<string, SettingComponent> {
  const registry = new Map<string, SettingComponent>();

  // --- General ---------------------------------------------------------
  registry.set(
    'memory.autoAccept',
    new BooleanSetting({
      id: 'memory.autoAccept',
      label: 'Memory auto-accept',
      restart: false,
      read: (ctx) => matchBool(ctx.readYaml(), /^\s+autoAccept:\s*(true|false)\s*$/m, true),
      write: (ctx, next) => {
        const body = ctx.readYaml();
        ctx.writeYaml(body.replace(/^(\s+autoAccept:\s*)(true|false)\s*$/m, `$1${next}`));
      },
    }),
  );

  // --- Service ---------------------------------------------------------
  // Per-agent settings (model / cheap fallback / router / skills) live
  // on the dashboard now: open /agents in a browser and click Edit on a
  // row. The CLI used to surface them but only ever edited the FIRST
  // agent (silent foot-gun once a second agent gets added), and a
  // dropdown in a browser is plain nicer than an arrow-key picker.
  const LOG_LEVELS = [
    { value: 'debug' },
    { value: 'info' },
    { value: 'warn' },
    { value: 'error' },
  ];
  registry.set(
    'service.logLevel',
    new EnumSetting({
      id: 'service.logLevel',
      label: 'Log level',
      pathLabel: 'service.logLevel',
      restart: false,
      read: (ctx) => matchString(ctx.readYaml(), /^\s+logLevel:\s*(\w+)\s*$/m, 'info'),
      patchRegex: /^(\s+logLevel:\s*)\w+\s*$/m,
      options: LOG_LEVELS,
    }),
  );
  registry.set(
    'telegram.conversationHistoryLimit',
    new IntegerSetting({
      id: 'telegram.conversationHistoryLimit',
      label: 'Conversation history',
      pathLabel: 'telegram.conversationHistoryLimit',
      restart: false,
      read: (ctx) =>
        matchInt(ctx.readYaml(), /^\s+conversationHistoryLimit:\s*(\d+)\s*$/m, 50),
      patchRegex: /^(\s+conversationHistoryLimit:\s*)\d+\s*$/m,
      bounds: { min: 0, max: 500 },
      format: (n) => `${n} msgs`,
    }),
  );

  // --- Budget ----------------------------------------------------------
  registry.set(
    'budget.dailyTokenLimit',
    new IntegerSetting({
      id: 'budget.dailyTokenLimit',
      label: 'Daily token budget',
      pathLabel: 'budget.dailyTokenLimit',
      restart: false,
      read: (ctx) => matchInt(ctx.readYaml(), /^\s+dailyTokenLimit:\s*(\d+)\s*$/m, 2_000_000),
      patchRegex: /^(\s+dailyTokenLimit:\s*)\d+\s*$/m,
      bounds: { min: 0 },
    }),
  );
  registry.set(
    'budget.perSessionTokenLimit',
    new IntegerSetting({
      id: 'budget.perSessionTokenLimit',
      label: 'Per-session limit',
      pathLabel: 'budget.perSessionTokenLimit',
      restart: false,
      read: (ctx) => matchInt(ctx.readYaml(), /^\s+perSessionTokenLimit:\s*(\d+)\s*$/m, 200_000),
      patchRegex: /^(\s+perSessionTokenLimit:\s*)\d+\s*$/m,
      bounds: { min: 0 },
    }),
  );
  registry.set(
    'messages.retentionDays',
    new IntegerOrNullSetting({
      id: 'messages.retentionDays',
      label: 'Message retention',
      pathLabel: 'messages.retentionDays',
      restart: false,
      read: (ctx) => matchIntOrNull(ctx.readYaml(), /^\s+retentionDays:\s*(null|\d+)\s*$/m),
      patchRegex: /^(\s+retentionDays:\s*)(null|\d+)\s*$/m,
      bounds: { min: 1 },
    }),
  );

  // --- Telegram --------------------------------------------------------
  registry.set(
    'telegram.allowedUserIds',
    new ListSetting({
      id: 'telegram.allowedUserIds',
      label: 'Allowed users',
      pathLabel: 'telegram.dm.allowedUserIds',
      restart: true,
      read: (ctx) => matchIntList(ctx.readYaml(), /^\s+allowedUserIds:\s*\[(.*?)\]/m),
      patchRegex: /^(\s+allowedUserIds:\s*)\[.*\]\s*$/m,
      emptyLabel: '(none — bot rejects all DMs)',
    }),
  );
  registry.set(
    'voice.enabled',
    new BooleanSetting({
      id: 'voice.enabled',
      label: 'Voice input',
      restart: false,
      read: (ctx) => ctx.voiceState.getEnabled(),
      write: (ctx, next) => ctx.voiceState.setEnabled(next),
      canToggle: (ctx, current) => {
        if (current) return null; // always allowed to disable
        const key = (ctx.readEnv().GROQ_API_KEY ?? '').trim();
        return key ? null : 'set the Groq API key first, then enable.';
      },
    }),
  );
  registry.set(
    'voice.groqKey',
    new SecretSetting({
      id: 'voice.groqKey',
      label: 'Groq API key',
      restart: true,
      storage: { kind: 'env', key: 'GROQ_API_KEY' },
      onRemove: (ctx) => ctx.voiceState.setEnabled(false),
    }),
  );
  registry.set(
    'voice.test',
    new ActionSetting({
      id: 'voice.test',
      label: 'Test transcription',
      renderMeta: (ctx) => {
        const key = (ctx.readEnv().GROQ_API_KEY ?? '').trim();
        return key ? '(upload a local audio file)' : '(set API key first)';
      },
      action: runVoiceTest,
    }),
  );

  // --- Dashboard -------------------------------------------------------
  registry.set(
    'dashboard.enabled',
    new BooleanSetting({
      id: 'dashboard.enabled',
      label: 'Dashboard (web UI)',
      restart: true,
      read: (ctx) =>
        matchBool(ctx.readYaml(), /^dashboard:\s*\n  enabled:\s*(true|false)\s*$/m, false),
      write: (ctx, next) => {
        const body = ctx.readYaml();
        ctx.writeYaml(
          body.replace(
            /^(dashboard:\s*\n  enabled:\s*)(true|false)\s*$/m,
            `$1${next}`,
          ),
        );
      },
    }),
  );
  registry.set(
    'dashboard.basicAuth.enabled',
    new BooleanSetting({
      id: 'dashboard.basicAuth.enabled',
      label: 'Basic-auth protection',
      restart: true,
      read: (ctx) =>
        matchBool(ctx.readYaml(), /^  basicAuth:\s*\n    enabled:\s*(true|false)\s*$/m, false),
      write: (ctx, next) => {
        const body = ctx.readYaml();
        ctx.writeYaml(
          body.replace(
            /^(  basicAuth:\s*\n    enabled:\s*)(true|false)\s*$/m,
            `$1${next}`,
          ),
        );
      },
    }),
  );
  registry.set(
    'dashboard.basicAuth.passwordHash',
    new SecretSetting({
      id: 'dashboard.basicAuth.passwordHash',
      label: 'Dashboard password',
      restart: true,
      storage: {
        kind: 'yaml',
        regex: /^(\s+passwordHash:\s*)['"]?([^'"\n]*)['"]?\s*$/m,
        pathLabel: 'dashboard.basicAuth.passwordHash',
        quoteValue: true,
      },
      // Store the argon2id hash in the yaml; we never round-trip the
      // plaintext.
      transform: hashArgon2,
    }),
  );

  // --- Advanced (read-only views) -------------------------------------
  // Surface the agent registry + the resolved policy file in the menu
  // so the operator doesn't have to drop to a shell. These are
  // intentionally view-only — full editing happens via direct file
  // edits + `andybioticlaw policy reload` for syntax-checking.
  registry.set(
    'agents.show',
    new ActionSetting({
      id: 'agents.show',
      label: 'Agents (read-only)',
      renderMeta: () => '(list configured agents)',
      action: showAgents,
    }),
  );
  registry.set(
    'policies.show',
    new ActionSetting({
      id: 'policies.show',
      label: 'Policies (read-only)',
      renderMeta: () => '(per-context schedule kinds + exec mode + skills)',
      action: showPolicies,
    }),
  );

  return registry;
}

/**
 * "Agents" view — prints the configured agents.
 */
async function showAgents(ctx: SettingsContext): Promise<void> {
  const { loadConfig } = await import('../../config/load.js');
  const config = loadConfig(ctx.configPath).config;
  ctx.stdout.write('\n');
  for (const a of config.agents) {
    const flag = a.default ? sage('*') : ' ';
    const skills = a.skills.join(', ');
    ctx.stdout.write(
      `  ${flag} ${cyan(a.id)}  ${a.name}  ${dim(a.model)}  ${dim(`skills=${skills}`)}\n`,
    );
  }
}

/**
 * "Policies" view — prints every per-context resolved policy. Reads
 * `data/policies.json` fresh each time. If the file is missing, points
 * the operator at the auto-generation path.
 */
async function showPolicies(ctx: SettingsContext): Promise<void> {
  const { loadPolicies, resolvePolicy } = await import('../../policies/repo.js');
  const { policiesPath: ppath, expandPath } = await import('../../config/paths.js');
  const { loadConfig, projectRoot } = await import('../../config/load.js');
  const config = loadConfig(ctx.configPath).config;
  const dataDir = expandPath(config.service.dataDir, projectRoot());
  const path = ppath(dataDir);
  ctx.stdout.write('\n');
  let file;
  try {
    file = loadPolicies(path);
  } catch (e) {
    ctx.stdout.write(`  ${yellow('!')} ${(e as Error).message}\n`);
    return;
  }
  if (!file) {
    ctx.stdout.write(
      `  ${dim('no policies file at')} ${cyan(path)}\n`,
    );
    ctx.stdout.write(
      `  ${dim('start the service once and it will be auto-generated.')}\n`,
    );
    return;
  }
  const keys = Object.keys(file.contexts);
  if (keys.length === 0) {
    ctx.stdout.write(`  ${dim('(no per-context policies; only defaults apply)')}\n`);
    return;
  }
  ctx.stdout.write(`  ${dim(`source: ${path}`)}\n\n`);
  for (const key of keys) {
    let resolved;
    try {
      resolved = resolvePolicy(file, key);
    } catch (e) {
      ctx.stdout.write(`  ${yellow('!')} ${cyan(key)}: ${(e as Error).message}\n`);
      continue;
    }
    ctx.stdout.write(`  ${cyan(key)}\n`);
    if (resolved._label) {
      ctx.stdout.write(`    ${dim(resolved._label)}\n`);
    }
    ctx.stdout.write(
      `    ${dim('schedule:')} ${resolved.scheduleKinds.join(', ')} ${dim(`(cap=${resolved.scheduleAgentTaskCap})`)}\n`,
    );
    ctx.stdout.write(
      `    ${dim('exec:')}     ${resolved.execMode}` +
        (resolved.execAllow.length > 0 ? ` ${dim(`(${resolved.execAllow.length} pattern(s))`)}` : '') +
        '\n',
    );
    ctx.stdout.write(`    ${dim('skills:')}   ${resolved.skillsVisible.join(', ')}\n`);
  }
}

/**
 * The one-shot "Test transcription" action. Extracted to a module-
 * scoped function so it's not cluttering the registry map literal.
 */
async function runVoiceTest(ctx: SettingsContext): Promise<void> {
  const key = (ctx.readEnv().GROQ_API_KEY ?? '').trim();
  if (!key) {
    ctx.stdout.write(
      `\n  ${yellow('!')} ${dim('no Groq API key set — configure it first.')}\n`,
    );
    return;
  }
  const pathInput = await askLine(
    ctx.stdin,
    ctx.stdout,
    `\n  ${lavender('?')} Path to a local audio file (ogg/mp3/m4a/wav)${dim(':')} `,
  );
  if (pathInput === null || pathInput.trim() === '') {
    ctx.stdout.write(`\n  ${dim('(aborted)')}\n`);
    return;
  }
  const abs = resolve(pathInput.trim());
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    ctx.stdout.write(
      `\n  ${yellow('!')} ${dim(`could not read ${abs}: ${(e as Error).message}`)}\n`,
    );
    return;
  }
  ctx.stdout.write(
    `\n  ${dim('▸ uploading')} ${cyan(`${(buf.length / 1024).toFixed(1)} KB`)}${dim(' to Groq…')}\n`,
  );
  try {
    const { text, durationSec } = await transcribeWithGroq(buf, { apiKey: key });
    if (!text) {
      ctx.stdout.write(
        `\n  ${yellow('!')} ${dim('Groq returned no transcript (silent audio?)')}\n`,
      );
      return;
    }
    ctx.stdout.write(
      `\n  ${sage('✓')} ${dim('transcript')}${
        durationSec ? dim(` (~${durationSec.toFixed(1)}s audio)`) : ''
      }${dim(':')}\n\n`,
    );
    ctx.stdout.write(`  ${text}\n\n`);
  } catch (e) {
    ctx.stdout.write(
      `\n  ${yellow('!')} ${dim(`transcription failed: ${(e as Error).message}`)}\n`,
    );
  }
}

// Re-exports used by tests.
export { passwordHashIsSet };
