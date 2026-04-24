import pino from 'pino';
import { bootstrapEnv, loadConfig, projectRoot } from '../config/load.js';
import { defaultEnvPath, expandPath, sqliteDbPath } from '../config/paths.js';
import { openDatabase } from '../db/index.js';
import { createVoiceStateRepo } from '../db/repositories/voice-state.js';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';
import { transcribeWithGroq } from '../telegram/voice.js';
import { arrowPicker, askLine, askSecret, releaseStdin } from './prompt-helpers.js';
import { cyan, dim, green, lavender, sage, yellow } from './ansi.js';
import { section } from './section.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Top-level "Configure voice input" submenu. Parallels `runSkillMenuCommand`:
 * opens a DB handle, reads current state, loops a picker, dispatches to a
 * small handler for each action, and closes the DB on exit.
 *
 * Three user-visible commands the operator drives from here:
 *   - toggle enabled/disabled (SQLite, hot — no restart)
 *   - set / update / remove the Groq API key (.env, needs restart)
 *   - test-transcribe a local audio file (sanity-check the key without
 *     waiting for a voice message over Telegram)
 */
export async function runVoiceMenuCommand(): Promise<void> {
  bootstrapEnv();
  const loaded = loadConfig();
  const config = loaded.config;
  const dataDir = expandPath(config.service.dataDir, projectRoot());
  const logger = pino({ level: 'warn' });
  const dbHandle = openDatabase(sqliteDbPath(dataDir), logger);
  const stdin = process.stdin as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void;
  };
  const stdout = process.stdout;
  const envPath = defaultEnvPath(projectRoot());

  try {
    const voiceState = createVoiceStateRepo(dbHandle.db);

    section(stdout, 'voice', 'Configure voice input');
    stdout.write(
      `  ${dim('transcribes Telegram voice messages via Groq Whisper,')}\n` +
        `  ${dim('feeds the text to Emma as a regular DM')}\n`,
    );

    while (true) {
      const env = readEnvFile(envPath).values;
      const hasKey = !!env.GROQ_API_KEY && env.GROQ_API_KEY.trim() !== '';
      const enabled = voiceState.getEnabled();

      const statusLine = renderStatus(enabled, hasKey, env.GROQ_API_KEY ?? '');
      stdout.write(`\n  ${statusLine}\n`);

      const items = [
        {
          label: enabled ? 'Disable voice input' : 'Enable voice input',
          meta: enabled ? ' currently ON' : ' currently off',
        },
        {
          label: hasKey ? 'Update Groq API key' : 'Set Groq API key',
          meta: hasKey ? ' (already configured)' : '',
        },
        { label: 'Remove Groq API key', meta: '' },
        { label: 'Test transcription on a local file', meta: '' },
        { label: 'Back', meta: '' },
      ];

      const idx = await arrowPicker(stdin, stdout, {
        title: 'Voice input',
        helpLine: '↑/↓ move · Enter select · q back',
        items,
      });
      if (idx < 0 || idx === items.length - 1) return;

      if (idx === 0) {
        if (!enabled) {
          if (!hasKey) {
            stdout.write(
              `\n  ${yellow('!')} ${dim('no Groq API key set — set it first, then enable.')}\n`,
            );
            continue;
          }
          voiceState.setEnabled(true);
          stdout.write(
            `\n  ${sage('✓')} ${dim('voice input enabled (takes effect immediately — no restart needed).')}\n`,
          );
        } else {
          voiceState.setEnabled(false);
          stdout.write(
            `\n  ${sage('✓')} ${dim('voice input disabled (takes effect immediately).')}\n`,
          );
        }
        continue;
      }

      if (idx === 1) {
        const value = await askSecret(
          stdin,
          stdout,
          `\n  ${lavender('?')} Groq API key${dim(' (input hidden):')} `,
        );
        if (value === null) {
          stdout.write(`\n  ${dim('(aborted — no change)')}\n`);
          continue;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          stdout.write(
            `\n  ${yellow('!')} ${dim('empty value — nothing written.')}\n`,
          );
          continue;
        }
        writeEnvFileUpdates(envPath, { GROQ_API_KEY: trimmed });
        stdout.write(
          `\n  ${sage('✓')} ${dim('saved to')} ${cyan(envPath)}${dim(' (0600).')} ` +
            `${yellow('restart required:')} ${dim('run')} ` +
            `${cyan('sudo systemctl restart andybioticlaw')} ${dim('to pick up the key.')}\n`,
        );
        continue;
      }

      if (idx === 2) {
        if (!hasKey) {
          stdout.write(
            `\n  ${dim('(no key set — nothing to remove)')}\n`,
          );
          continue;
        }
        writeEnvFileUpdates(envPath, { GROQ_API_KEY: '' });
        voiceState.setEnabled(false);
        stdout.write(
          `\n  ${sage('✓')} ${dim('key cleared + voice disabled. Restart to purge the old key from process env.')}\n`,
        );
        continue;
      }

      if (idx === 3) {
        await runTestTranscribe({
          stdin,
          stdout,
          envKey: env.GROQ_API_KEY ?? '',
          language: config.telegram.voice.language,
        });
        continue;
      }
    }
  } finally {
    dbHandle.close();
    releaseStdin();
  }
}

function renderStatus(enabled: boolean, hasKey: boolean, key: string): string {
  const enabledPart = enabled
    ? green('● enabled')
    : dim('○ disabled');
  const keyPart = hasKey
    ? `${sage('✓')} key: ${dim(maskKey(key))}`
    : `${yellow('!')} key: ${dim('not set')}`;
  return `${enabledPart}  ${dim('·')}  ${keyPart}`;
}

/**
 * Mask the middle of a secret for display. `gsk_xxxxxxxxY8k3` → `gsk_xxxxxx...Y8k3`
 * Keeps the first 6 and last 4 chars visible — enough to cross-check against
 * the Groq dashboard without leaking enough to be useful.
 */
function maskKey(key: string): string {
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 6)}${'•'.repeat(8)}${key.slice(-4)}`;
}

/**
 * One-shot sanity check: read a local audio file, POST to Groq, print the
 * transcript. Avoids the "why isn't my voice working" loop of sending a
 * Telegram voice message, waiting, and seeing only a generic error.
 */
async function runTestTranscribe(input: {
  stdin: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void };
  stdout: NodeJS.WritableStream;
  envKey: string;
  language: string;
}): Promise<void> {
  const { stdin, stdout, envKey, language } = input;
  if (!envKey) {
    stdout.write(
      `\n  ${yellow('!')} ${dim('no Groq API key set — set it first.')}\n`,
    );
    return;
  }
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
  stdout.write(`\n  ${dim('▸ uploading')} ${cyan(`${(buf.length / 1024).toFixed(1)} KB`)}${dim(' to Groq…')}\n`);
  try {
    const { text, durationSec } = await transcribeWithGroq(buf, {
      apiKey: envKey,
      language,
    });
    if (!text) {
      stdout.write(
        `\n  ${yellow('!')} ${dim('Groq returned no transcript (silent audio?)')}\n`,
      );
      return;
    }
    stdout.write(
      `\n  ${sage('✓')} ${dim('transcript')} ${durationSec ? dim(`(~${durationSec.toFixed(1)}s audio)`) : ''}${dim(':')}\n\n`,
    );
    stdout.write(`  ${text}\n\n`);
  } catch (e) {
    stdout.write(
      `\n  ${yellow('!')} ${dim(`transcription failed: ${(e as Error).message}`)}\n`,
    );
  }
}
