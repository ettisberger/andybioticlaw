import { createInterface } from 'node:readline';
import type { WizardQuestion, SetupWizard } from '../skills/manifest.js';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';

/**
 * Interactive terminal wizard for skill setup. Drives `readline`, respects
 * already-set env vars (silently skips), masks password input, applies tiny
 * built-in validators. No external deps.
 */

export interface WizardRunOptions {
  skillName: string;
  wizard: SetupWizard;
  envPath: string;
  /** Input stream. Defaults to process.stdin — overridable for tests. */
  input?: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void };
  /** Output stream. Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
}

export interface WizardRunOutcome {
  reused: string[];
  collected: string[];
  skippedEmpty: string[];
  writes: { updated: string[]; appended: string[] };
}

export async function runSetupWizard(
  opts: WizardRunOptions,
): Promise<WizardRunOutcome> {
  const stdin = (opts.input ?? process.stdin) as NodeJS.ReadableStream & {
    setRawMode?: (mode: boolean) => void;
  };
  const stdout = opts.output ?? process.stdout;

  const existing = readEnvFile(opts.envPath);
  const reused: string[] = [];
  const collected: string[] = [];
  const skippedEmpty: string[] = [];
  const toWrite: Record<string, string> = {};

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  stdout.write(`\n${opts.skillName} — ${opts.wizard.description}\n\n`);

  const totalAsked = opts.wizard.questions.filter(
    (q) => !existing.values[q.key] || existing.values[q.key] === '',
  ).length;
  const alreadySet = opts.wizard.questions.length - totalAsked;

  stdout.write(
    `Collecting configuration (${opts.wizard.questions.length} values; ${alreadySet} already in .env):\n`,
  );

  try {
    for (const q of opts.wizard.questions) {
      const current = existing.values[q.key];
      if (current !== undefined && current !== '') {
        reused.push(q.key);
        const shown = q.secret ? '"***"' : `"${truncate(current, 40)}"`;
        stdout.write(`  ✓ ${q.key.padEnd(18)}= ${shown.padEnd(44)} (already set, reusing)\n`);
        continue;
      }

      const answer = await askOne(rl, stdin, stdout, q);

      if (answer === null) {
        // User interrupted (Ctrl-C or EOF). Abort.
        stdout.write('\nwizard aborted — no changes written.\n');
        throw new WizardAbortedError();
      }
      if (answer === '' && q.default) {
        collected.push(q.key);
        toWrite[q.key] = q.default;
        continue;
      }
      if (answer === '') {
        skippedEmpty.push(q.key);
        stdout.write(`  (skipped — left empty)\n`);
        continue;
      }
      collected.push(q.key);
      toWrite[q.key] = answer;
    }
  } finally {
    rl.close();
  }

  let writes: { updated: string[]; appended: string[] } = {
    updated: [],
    appended: [],
  };
  if (Object.keys(toWrite).length > 0) {
    stdout.write(
      `\nWriting ${Object.keys(toWrite).length} value(s) to ${opts.envPath}…\n`,
    );
    writes = writeEnvFileUpdates(opts.envPath, toWrite);
    stdout.write(`  updated: ${writes.updated.join(', ') || '(none)'}\n`);
    stdout.write(`  appended: ${writes.appended.join(', ') || '(none)'}\n`);
  }

  return { reused, collected, skippedEmpty, writes };
}

async function askOne(
  rl: ReturnType<typeof createInterface>,
  stdin: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void },
  stdout: NodeJS.WritableStream,
  q: WizardQuestion,
): Promise<string | null> {
  if (q.help) {
    stdout.write(`\n  ${q.help}\n`);
  } else {
    stdout.write('\n');
  }
  const defaultHint = q.default ? ` [${q.secret ? '***' : q.default}]` : '';
  const suffix = q.secret ? ' (hidden)' : '';
  const prompt = `  ? ${q.key} — ${q.prompt}${defaultHint}${suffix}: `;

  while (true) {
    const raw = q.secret
      ? await readSecret(stdin, stdout, prompt)
      : await readLine(rl, prompt);
    if (raw === null) return null;
    const trimmed = raw.trim();
    const value = trimmed === '' && q.default ? q.default : trimmed;

    if (!value && q.validate === 'nonempty') {
      stdout.write(`  ! ${q.key} cannot be empty. Try again.\n`);
      continue;
    }
    if (!value) {
      // empty and no nonempty validator and no default → allow
      return '';
    }
    const err = validate(value, q.validate);
    if (err) {
      stdout.write(`  ! ${err} Try again.\n`);
      continue;
    }
    return value;
  }
}

function validate(value: string, kind: WizardQuestion['validate']): string | null {
  if (!kind) return null;
  switch (kind) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'not a valid email address.';
    case 'port': {
      const n = Number(value);
      return Number.isInteger(n) && n > 0 && n <= 65535
        ? null
        : 'port must be an integer 1–65535.';
    }
    case 'url':
      return /^https?:\/\/\S+$/i.test(value) ? null : 'not a valid http(s) URL.';
    case 'nonempty':
      return value.length > 0 ? null : 'value required.';
    default:
      return null;
  }
}

function readLine(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => resolve(ans));
    rl.once('close', () => resolve(null));
  });
}

/**
 * Masked password reader. Flips stdin into raw mode, echoes `*` per
 * keystroke, restores cooked mode on Enter. Backspace supported.
 */
async function readSecret(
  stdin: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void },
  stdout: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  stdout.write(prompt);
  return new Promise((resolve) => {
    let input = '';

    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      for (const char of s) {
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\x03') {
          // Ctrl+C
          cleanup();
          stdout.write('\n');
          resolve(null);
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        // Ignore other control characters.
        if (char.charCodeAt(0) < 0x20) continue;
        input += char;
        stdout.write('*');
      }
    };

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      // Do NOT pause stdin here — the next readline.question expects it
      // to still be flowing, otherwise the next prompt closes immediately.
    };

    if (stdin.setRawMode) stdin.setRawMode(true);
    (stdin as unknown as { resume?: () => void }).resume?.();
    stdin.on('data', onData);
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export class WizardAbortedError extends Error {
  constructor() {
    super('wizard aborted');
    this.name = 'WizardAbortedError';
  }
}
