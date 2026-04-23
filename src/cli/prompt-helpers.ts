import { yellow, dim, pink, bold } from './ansi.js';

/**
 * Shared raw-mode prompt helpers used by `init`, `edit-config`, and any
 * other interactive CLI flow. Deliberately avoids Node's `readline` —
 * its persistent data listener can't be cleanly suspended across a
 * raw-mode secret read, and ended up double-echoing characters.
 *
 * All helpers operate on the same Stdin/Stdout, set raw mode on entry
 * and reset it on exit. Cancellation (Ctrl-C / Ctrl-D on empty line)
 * resolves to `null` so callers can distinguish abort from empty input.
 */

export type Stdin = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
};

/**
 * Low-level char-by-char input. `mask=true` echoes `*` per keystroke
 * (use for secrets). Backspace works; arrow keys are ignored.
 */
export function readOneLine(
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
          // Ctrl-D on empty line → abort
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
        // Ignore other control chars (e.g. arrow-key escape seqs).
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

export function askLine(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  return readOneLine(stdin, stdout, prompt, false);
}

export function askSecret(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  return readOneLine(stdin, stdout, prompt, true);
}

// --- typed wrappers ---------------------------------------------------

export interface AskIntegerOptions {
  /** Inclusive lower bound (default: -Infinity). */
  min?: number;
  /** Inclusive upper bound (default: Infinity). */
  max?: number;
  /** Default value if user presses Enter on empty input. */
  default?: number;
  /** When true, accepting empty / "null" / "none" returns null. */
  allowNull?: boolean;
  /** Override the inline error message on bad input. */
  errorHint?: string;
}

/**
 * Loops until the user enters a valid integer in `[min, max]` (or null
 * when `allowNull`). Returns `null` on Ctrl-C — caller should treat
 * that as "abort" distinct from a `null` user-chosen value.
 */
export async function askInteger(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
  opts: AskIntegerOptions = {},
): Promise<number | null | 'aborted'> {
  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  while (true) {
    const raw = await askLine(stdin, stdout, prompt);
    if (raw === null) return 'aborted';
    const trimmed = raw.trim();
    if (trimmed === '' && opts.default !== undefined) return opts.default;
    if (opts.allowNull && (trimmed === '' || /^(null|none)$/i.test(trimmed))) {
      return null;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < min || n > max) {
      const range =
        opts.errorHint ??
        `must be an integer${
          isFinite(min) || isFinite(max)
            ? ` in [${isFinite(min) ? min : '-∞'}, ${isFinite(max) ? max : '∞'}]`
            : ''
        }`;
      stdout.write(`  ${yellow('!')} ${dim(`${range} — try again`)}\n`);
      continue;
    }
    return n;
  }
}

/**
 * Type-narrowed wrapper that errors on `'aborted'` so callers expecting
 * a definite number can rely on the return type. Used where the caller
 * has its own abort handling earlier in the flow.
 */
export async function askIntegerStrict(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
  opts: AskIntegerOptions = {},
): Promise<number | null> {
  const result = await askInteger(stdin, stdout, prompt, opts);
  if (result === 'aborted') return null;
  return result;
}

/**
 * Pick one of N labelled options. Accepts numeric shortcut (1..N) OR
 * an exact match against the option `value`. Returns the chosen value,
 * or null on Ctrl-C / unmatched input after retry.
 */
export async function askEnum<T extends string>(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
  options: ReadonlyArray<{ value: T; label?: string }>,
  opts: { default?: T } = {},
): Promise<T | null> {
  // Print the choices once before the prompt.
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const isDefault = opts.default !== undefined && opt.value === opts.default;
    const tag = isDefault ? dim(' (default)') : '';
    stdout.write(
      `    ${dim(`[${i + 1}]`)} ${opt.label ?? opt.value}${tag}\n`,
    );
  }
  while (true) {
    const raw = await askLine(stdin, stdout, prompt);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed === '' && opts.default !== undefined) return opts.default;
    // Numeric shortcut
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1]!.value;
    }
    // Exact match
    const match = options.find((o) => o.value === trimmed);
    if (match) return match.value;
    stdout.write(
      `  ${yellow('!')} ${dim(
        `pick a number 1–${options.length} or one of: ${options.map((o) => o.value).join(', ')}`,
      )}\n`,
    );
  }
}

/**
 * yes/no prompt with optional default. `y` / `yes` / `true` → true,
 * `n` / `no` / `false` → false, empty → default. Loops on bad input.
 */
export async function askBoolean(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  prompt: string,
  opts: { default?: boolean } = {},
): Promise<boolean | null> {
  while (true) {
    const raw = await askLine(stdin, stdout, prompt);
    if (raw === null) return null;
    const t = raw.trim().toLowerCase();
    if (t === '' && opts.default !== undefined) return opts.default;
    if (['y', 'yes', 'true', '1', 'on'].includes(t)) return true;
    if (['n', 'no', 'false', '0', 'off'].includes(t)) return false;
    stdout.write(
      `  ${yellow('!')} ${dim('please answer y or n — try again')}\n`,
    );
  }
}

// --- arrow-key picker -------------------------------------------------

const ESC_UP = '\x1b[A';
const ESC_DOWN = '\x1b[B';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export interface PickerItem {
  /** Main label rendered as the choice text. */
  label: string;
  /** Optional secondary text rendered to the right (current value, hint, etc.). */
  meta?: string;
  /** Optional trailing tag rendered after `meta`, e.g. " (live)" / " (restart)". */
  tag?: string;
}

export interface PickerOptions {
  /** Items to choose from. */
  items: ReadonlyArray<PickerItem>;
  /** Title rendered above the list. */
  title?: string;
  /** Index that's highlighted on first render (default 0). */
  initialIndex?: number;
  /** Help line shown below the title (default: arrow / enter / quit hint). */
  helpLine?: string;
  /** Optional footer printed below the list. */
  footer?: string;
}

/**
 * Arrow-key + Enter picker. Highlights the selected row in pink.
 * Returns the chosen item's index, or `-1` on q / Ctrl-C.
 *
 * Falls back to numeric input when stdin is not a TTY (e.g. piped) —
 * just auto-picks index 0 in that case.
 */
export function arrowPicker(
  stdin: Stdin,
  stdout: NodeJS.WritableStream,
  opts: PickerOptions,
): Promise<number> {
  const items = opts.items;
  if (items.length === 0) return Promise.resolve(-1);

  return new Promise((resolve) => {
    if (!stdin.setRawMode) {
      // Non-TTY (e.g. piped / scripted): auto-select first item.
      resolve(0);
      return;
    }

    let index = Math.max(0, Math.min(opts.initialIndex ?? 0, items.length - 1));
    let firstDraw = true;
    const labelWidth = items.reduce((m, it) => Math.max(m, it.label.length), 0);
    // Total vertical lines consumed by one redraw — used both to rewind
    // the cursor between redraws and to wipe the rendered region on exit.
    const totalLines =
      (opts.title ? 2 : 0) + (opts.helpLine ? 2 : 0) + items.length + (opts.footer ? 2 : 0) + 1;

    const redraw = (): void => {
      if (!firstDraw) {
        // Move cursor up to the start of the previously-printed block,
        // then clear from there to end of screen — keeps shell history
        // above intact.
        stdout.write(`\x1b[${totalLines}A\x1b[J`);
      }
      firstDraw = false;
      stdout.write('\n');
      if (opts.title) {
        stdout.write(`  ${bold(opts.title)}\n\n`);
      }
      if (opts.helpLine) {
        stdout.write(`  ${dim(opts.helpLine)}\n\n`);
      }
      items.forEach((it, i) => {
        const selected = i === index;
        const arrow = selected ? pink('▸ ') : '  ';
        const label = it.label.padEnd(labelWidth);
        const labelPainted = selected ? pink(bold(label)) : dim(label);
        const meta = it.meta ? `  ${selected ? pink(it.meta) : dim(it.meta)}` : '';
        const tag = it.tag ? `${selected ? pink(it.tag) : dim(it.tag)}` : '';
        stdout.write(`  ${arrow}${labelPainted}${meta}${tag}\n`);
      });
      if (opts.footer) {
        stdout.write(`\n  ${dim(opts.footer)}\n`);
      }
    };

    const cleanup = (): void => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      // Wipe the rendered menu so the next output (or the shell prompt)
      // lands at the original cursor position. Without this wipe the
      // menu lingers on screen — the user is visually "in the menu"
      // even though the picker has already resolved.
      if (!firstDraw) {
        stdout.write(`\x1b[${totalLines}A\x1b[J`);
      }
      stdout.write(SHOW_CURSOR);
    };

    const onData = (chunk: Buffer): void => {
      const s = chunk.toString();
      if (s === '\x03' || s === 'q' || s === 'Q') {
        cleanup();
        resolve(-1);
        return;
      }
      if (s === '\r' || s === '\n') {
        cleanup();
        resolve(index);
        return;
      }
      if (s === ESC_UP || s === 'k') {
        index = (index - 1 + items.length) % items.length;
        redraw();
        return;
      }
      if (s === ESC_DOWN || s === 'j') {
        index = (index + 1) % items.length;
        redraw();
        return;
      }
      // Number shortcut 1..9
      if (/^[1-9]$/.test(s)) {
        const n = Number(s) - 1;
        if (n < items.length) {
          cleanup();
          resolve(n);
          return;
        }
      }
    };

    stdout.write(HIDE_CURSOR);
    stdin.setRawMode(true);
    (stdin as unknown as { resume?: () => void }).resume?.();
    stdin.on('data', onData);
    redraw();
  });
}
