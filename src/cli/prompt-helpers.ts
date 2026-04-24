import { yellow, dim, pink, bold, sage } from './ansi.js';

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
 * Pause stdin so node's event loop can exit after an interactive flow.
 * Every helper in this file calls `stdin.resume()` on entry (to unpause
 * it from whatever state it was in) but never pauses it back — which
 * means after the prompt resolves, the TTY keeps the process alive.
 * Interactive CLI entry points must call this in a `finally` block so
 * `andybioticlaw config edit`, `andybioticlaw init`, etc. actually exit
 * when the user picks "Done" / finishes the wizard.
 */
export function releaseStdin(): void {
  const stdin = process.stdin as { pause?: () => void };
  if (typeof stdin.pause === 'function') stdin.pause();
}

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
  /**
   * If defined, the item is a toggleable checkbox: renders ☑ (green) when
   * true / ☐ (dim) when false. Enter on such a row calls
   * {@link PickerOptions.onToggle} if set, then continues the picker —
   * the user stays on the row and can watch it flip. Used by the
   * Settings menu to make every boolean setting feel the same.
   */
  checked?: boolean;
  /**
   * 'header' rows render as a dim section divider (e.g. "── General ──")
   * and are SKIPPED by arrow navigation and cannot be selected. 'item'
   * is the default.
   */
  kind?: 'header' | 'item';
}

export interface PickerOptions {
  /** Items to choose from. May be a static array OR a thunk — the thunk
   *  is re-invoked on every redraw, which is what makes in-place toggles
   *  work: caller mutates external state in `onToggle`, picker redraws,
   *  thunk produces fresh items with the updated `checked`. */
  items: ReadonlyArray<PickerItem> | (() => ReadonlyArray<PickerItem>);
  /** Title rendered above the list. */
  title?: string;
  /** Index that's highlighted on first render (default: first non-header). */
  initialIndex?: number;
  /** Help line shown below the title (default: arrow / enter / quit hint). */
  helpLine?: string;
  /** Optional footer printed below the list — thunk so it can update
   *  between redraws (e.g. "⚠ 2 changes pending restart"). */
  footer?: string | (() => string | undefined);
  /**
   * Called when Enter is pressed on a row whose `checked` is defined.
   * Receives the row's current index. Caller is expected to flip
   * external state; the picker then redraws (via the items thunk) so
   * the new checked value is visible, and stays open. Non-toggle rows
   * (checked undefined) resolve the picker as normal with the idx.
   */
  onToggle?: (idx: number) => void | Promise<void>;
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
  const getItems = (): ReadonlyArray<PickerItem> =>
    typeof opts.items === 'function' ? opts.items() : opts.items;
  const getFooter = (): string | undefined =>
    typeof opts.footer === 'function' ? opts.footer() : opts.footer;

  if (getItems().length === 0) return Promise.resolve(-1);

  return new Promise((resolve) => {
    if (!stdin.setRawMode) {
      // Non-TTY (e.g. piped / scripted): auto-select the first
      // selectable (non-header) item.
      const firstSelectable = getItems().findIndex(
        (it) => (it.kind ?? 'item') !== 'header',
      );
      resolve(firstSelectable >= 0 ? firstSelectable : 0);
      return;
    }

    // Start on the first SELECTABLE row, honouring initialIndex if it
    // points at one.
    let items = getItems();
    const indexIsSelectable = (i: number) =>
      i >= 0 && i < items.length && (items[i]!.kind ?? 'item') !== 'header';
    let index =
      opts.initialIndex !== undefined && indexIsSelectable(opts.initialIndex)
        ? opts.initialIndex
        : items.findIndex((it) => (it.kind ?? 'item') !== 'header');
    if (index < 0) index = 0;

    let firstDraw = true;
    // Last redraw's line count, so cleanup / next redraw can rewind.
    let lastLines = 0;

    const redraw = (): void => {
      items = getItems();
      // Clamp index if the items thunk shrunk the list.
      if (index >= items.length) index = items.length - 1;
      if (!indexIsSelectable(index)) {
        const next = items.findIndex(
          (it, i) => i >= index && (it.kind ?? 'item') !== 'header',
        );
        index = next >= 0 ? next : items.findIndex((it) => (it.kind ?? 'item') !== 'header');
        if (index < 0) index = 0;
      }

      const labelWidth = items
        .filter((it) => (it.kind ?? 'item') !== 'header')
        .reduce((m, it) => Math.max(m, visibleLength(it.label) + 4), 0);
      const footer = getFooter();

      if (!firstDraw) {
        stdout.write(`\x1b[${lastLines}A\x1b[J`);
      }
      firstDraw = false;

      const lines: string[] = [];
      lines.push('');
      if (opts.title) {
        lines.push(`  ${bold(opts.title)}`);
        lines.push('');
      }
      if (opts.helpLine) {
        lines.push(`  ${dim(opts.helpLine)}`);
        lines.push('');
      }
      items.forEach((it, i) => {
        const kind = it.kind ?? 'item';
        if (kind === 'header') {
          lines.push(`  ${dim(`── ${it.label} ──`)}`);
          return;
        }
        const selected = i === index;
        const arrow = selected ? pink('▸ ') : '  ';
        const checkbox =
          it.checked === undefined
            ? '   '
            : it.checked
              ? `${sage('☑')}  `
              : `${dim('☐')}  `;
        const paddedLabel = it.label.padEnd(
          Math.max(labelWidth - 4, it.label.length),
        );
        const labelPainted = selected ? pink(bold(paddedLabel)) : dim(paddedLabel);
        const meta = it.meta ? `  ${selected ? pink(it.meta) : dim(it.meta)}` : '';
        const tag = it.tag ? ` ${selected ? pink(it.tag) : dim(it.tag)}` : '';
        lines.push(`  ${arrow}${checkbox}${labelPainted}${meta}${tag}`);
      });
      if (footer) {
        lines.push('');
        lines.push(`  ${footer}`);
      }
      lines.push('');

      stdout.write(lines.join('\n') + '\n');
      lastLines = lines.length;
    };

    const cleanup = (): void => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(false);
      if (!firstDraw && lastLines > 0) {
        stdout.write(`\x1b[${lastLines}A\x1b[J`);
      }
      stdout.write(SHOW_CURSOR);
    };

    const step = (dir: 1 | -1): void => {
      // Skip header rows while navigating.
      const n = items.length;
      for (let k = 0; k < n; k += 1) {
        index = (index + dir + n) % n;
        if (indexIsSelectable(index)) break;
      }
      redraw();
    };

    const onData = async (chunk: Buffer): Promise<void> => {
      const s = chunk.toString();
      if (s === '\x03' || s === 'q' || s === 'Q') {
        cleanup();
        resolve(-1);
        return;
      }
      if (s === '\r' || s === '\n') {
        const current = items[index];
        if (current && current.checked !== undefined && opts.onToggle) {
          // Toggle in place — caller flips state, we redraw and stay open.
          // `await` so any async I/O (DB write, .env write) completes
          // before we reread items via the thunk.
          await opts.onToggle(index);
          redraw();
          return;
        }
        cleanup();
        resolve(index);
        return;
      }
      if (s === ESC_UP || s === 'k') {
        step(-1);
        return;
      }
      if (s === ESC_DOWN || s === 'j') {
        step(+1);
        return;
      }
      if (/^[1-9]$/.test(s)) {
        const n = Number(s) - 1;
        if (n < items.length && indexIsSelectable(n)) {
          const target = items[n]!;
          if (target.checked !== undefined && opts.onToggle) {
            index = n;
            await opts.onToggle(n);
            redraw();
            return;
          }
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

/**
 * Strip ANSI escape sequences when measuring label width — keeps the
 * right-aligned meta column lined up even when labels contain colours.
 */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[\d;]*m/g, '').length;
}
