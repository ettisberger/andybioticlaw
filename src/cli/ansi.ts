/**
 * Hand-rolled ANSI helpers — zero dependencies, enough for the terminal
 * menu's needs (greeting, selection highlight, dim footer).
 *
 * The helpers check `process.stdout.isTTY` lazily: if stdout is piped or
 * redirected (e.g. `andybioticlaw > out.txt`), we emit bare text so log
 * files aren't polluted with escape sequences.
 */

const ESC = '\x1b[';

function wrap(code: string): (s: string) => string {
  return (s) => (process.stdout.isTTY ? `${ESC}${code}m${s}${ESC}0m` : s);
}

export const bold = wrap('1');
export const dim = wrap('2');
export const italic = wrap('3');
export const underline = wrap('4');

export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

/** Subtle lavender-ish color using 24-bit truecolor. Falls back cleanly on
 *  non-truecolor terminals (they render as closest 256-color). */
export const lavender = wrap('38;2;180;163;220');
export const sage = wrap('38;2;164;196;154');

/** Vibrant pink — used to highlight the currently-selected item in
 *  arrow-key menus. Distinct from lavender so the cursor doesn't blend
 *  with brand-accent text. */
export const pink = wrap('38;2;236;72;153');

/** Clear screen + move cursor to top-left. Used by the menu to redraw
 *  cleanly on each keystroke. */
export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`${ESC}2J${ESC}H`);
}

/** Hide / show the cursor while the menu is drawing. */
export function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?25l`);
}
export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?25h`);
}

/** Enter / leave the terminal's alternate screen buffer (like vim/less).
 *  Anything drawn between these is wiped on leave and the original
 *  terminal contents are restored — gives the top-level menu a clean
 *  enter/exit so the operator isn't left "stuck in the menu" visually. */
export function enterAltScreen(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?1049h`);
}
export function exitAltScreen(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?1049l`);
}
