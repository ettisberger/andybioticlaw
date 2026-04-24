import type { WizardQuestion, SetupWizard } from '../skills/manifest.js';
import { readEnvFile, writeEnvFileUpdates } from '../config/env-file.js';
import { cyan, dim, lavender, sage, yellow } from './ansi.js';
import { section } from './section.js';

/**
 * Interactive terminal wizard for skill setup. Drives raw-mode stdin (no
 * readline — avoids the double-echo trap from mixing readline + raw-mode
 * secret prompts), applies built-in validators, respects already-set env
 * vars as defaults (Enter keeps, any typed value replaces).
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

  section(stdout, 'setup', opts.skillName);
  stdout.write(`  ${dim(opts.wizard.description)}\n`);

  const alreadySetCount = opts.wizard.questions.filter(
    (q) => existing.values[q.key] && existing.values[q.key] !== '',
  ).length;
  const total = opts.wizard.questions.length;
  const summary =
    alreadySetCount === 0
      ? `${total} value${total === 1 ? '' : 's'} to collect`
      : `${total} value${total === 1 ? '' : 's'} requested · ${alreadySetCount} already in .env — press Enter to keep, or type a new value to replace`;
  stdout.write(`  ${dim(summary)}\n`);

  try {
    for (const q of opts.wizard.questions) {
      const current = existing.values[q.key] ?? '';
      const hasCurrent = current !== '';
      const effectiveDefault = hasCurrent ? current : (q.default ?? '');

      const answer = await askOne(stdin, stdout, q, effectiveDefault, hasCurrent);

      if (answer === null) {
        stdout.write(`\n${yellow('!')} ${dim('wizard aborted — no new values written.')}\n`);
        throw new WizardAbortedError();
      }
      // Empty answer + we have a default → use the default (which equals
      // the currently-saved value when re-running after an earlier setup).
      if (answer === '' && effectiveDefault) {
        // Reusing an existing value → no write needed.
        if (hasCurrent && effectiveDefault === current) {
          reused.push(q.key);
          continue;
        }
        // Applying a manifest-level default that isn't saved yet → write it.
        collected.push(q.key);
        toWrite[q.key] = effectiveDefault;
        continue;
      }
      if (answer === '') {
        skippedEmpty.push(q.key);
        stdout.write(`  ${dim('(skipped — left empty)')}\n`);
        continue;
      }
      // A typed value — always write, even if it matches the current
      // (operator may have re-pasted to confirm; cheap to rewrite).
      collected.push(q.key);
      toWrite[q.key] = answer;
    }
  } finally {
    // No readline to close; raw-mode helpers tear down their own listeners.
    (stdin as unknown as { pause?: () => void }).pause?.();
  }

  let writes: { updated: string[]; appended: string[] } = {
    updated: [],
    appended: [],
  };
  if (Object.keys(toWrite).length > 0) {
    const n = Object.keys(toWrite).length;
    stdout.write(
      `\n  ${sage('✓')} ${dim(`writing ${n} value${n === 1 ? '' : 's'} to`)} ${cyan(opts.envPath)}${dim('…')}\n`,
    );
    writes = writeEnvFileUpdates(opts.envPath, toWrite);
    if (writes.updated.length > 0) {
      stdout.write(`    ${dim('updated:')}  ${writes.updated.join(', ')}\n`);
    }
    if (writes.appended.length > 0) {
      stdout.write(`    ${dim('appended:')} ${writes.appended.join(', ')}\n`);
    }
  } else if (reused.length === total) {
    stdout.write(
      `\n  ${dim('all values already set — nothing new written.')}\n`,
    );
  }

  return { reused, collected, skippedEmpty, writes };
}

type Stdin = NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void };

/**
 * Print a question's prompt and read one answer. The prompt is rendered in
 * the same visual language as the init wizard / edit-config menu:
 *
 *     <optional help in dim>
 *
 *     ? <prompt text>  [default: <value>]: <user input>
 *
 * The `KEY` identifier isn't shown — it's an implementation detail, not
 * something the operator needs to type. When a value is already set the
 * default is the current value (Enter to keep, type to replace). For
 * secrets the default is rendered as `***` so we don't leak.
 */
async function askOne(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  q: WizardQuestion,
  effectiveDefault: string,
  hasCurrent: boolean,
): Promise<string | null> {
  if (q.help) {
    stdout.write(`\n  ${dim(q.help)}\n`);
  } else {
    stdout.write('\n');
  }

  const suffix = q.secret ? dim(' (hidden input)') : '';
  let defaultHint = '';
  if (effectiveDefault) {
    const shown = q.secret ? '***' : truncate(effectiveDefault, 40);
    const label = hasCurrent ? 'keep current' : 'default';
    defaultHint = `  ${dim(`[${label}: ${shown}]`)}`;
  }
  const prompt =
    `  ${lavender('?')} ${q.prompt}${defaultHint}${suffix}${dim(':')} `;

  while (true) {
    const raw = await readOneLine(stdin, stdout, prompt, !!q.secret);
    if (raw === null) return null;
    const trimmed = raw.trim();
    const value = trimmed === '' && effectiveDefault ? effectiveDefault : trimmed;

    if (!value && q.validate === 'nonempty') {
      stdout.write(`  ${yellow('!')} ${dim(`${q.key} cannot be empty. Try again.`)}\n`);
      continue;
    }
    if (!value) {
      return '';
    }
    const err = validate(value, q.validate);
    if (err) {
      stdout.write(`  ${yellow('!')} ${dim(`${err} Try again.`)}\n`);
      continue;
    }
    // If the user pressed Enter on a re-run, return empty string so the
    // caller recognises "keep current" (see the effectiveDefault handling
    // in runSetupWizard). Otherwise return the typed value.
    return trimmed === '' ? '' : value;
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

/**
 * Raw-mode prompt. Handles Enter, Ctrl-C/D, backspace. When `mask` is
 * true echoes `*` per keystroke (for secrets); otherwise echoes the char.
 *
 * We deliberately do NOT use Node's readline here — mixing a persistent
 * readline listener with a raw-mode secret prompt produces double-echoed
 * characters. One raw-mode implementation for everything.
 */
function readOneLine(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
  mask: boolean,
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
          // Ctrl-C
          cleanup();
          stdout.write('\n');
          resolve(null);
          return;
        }
        if (char === '\x04' && input.length === 0) {
          // Ctrl-D on empty line
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
        // Ignore other control chars (e.g. stray arrow-key escape seqs).
        if (char.charCodeAt(0) < 0x20) continue;
        input += char;
        stdout.write(mask ? '*' : char);
      }
    };

    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
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
