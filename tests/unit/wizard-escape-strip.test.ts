import { describe, it, expect } from 'vitest';
import { stripEscapeSequences } from '../../src/cli/wizard.js';

/**
 * Regressions for the v0.9.x "pasted secret lands partially in .env"
 * class of bug. The raw-mode prompt used to filter out the lone ESC
 * byte but left the rest of each CSI / SS3 / Fe escape sequence — so
 * bracketed-paste markers (`\x1b[200~…\x1b[201~`), arrow-key codes
 * (`\x1b[A`), and the like polluted captured input.
 */
describe('stripEscapeSequences', () => {
  it('strips bracketed-paste start and end markers, keeping the payload', () => {
    const input = '\x1b[200~Ipk6wkZmZxVTca3QEz3S0kY7Q\x1b[201~';
    expect(stripEscapeSequences(input)).toBe('Ipk6wkZmZxVTca3QEz3S0kY7Q');
  });

  it('strips arrow-key CSI sequences', () => {
    // User arrows around while typing: `abc<left><left>XY<end>`
    const input = 'abc\x1b[D\x1b[DXY\x1b[F';
    expect(stripEscapeSequences(input)).toBe('abcXY');
  });

  it('strips SS3 (function-key) sequences like ESC O P (F1)', () => {
    expect(stripEscapeSequences('hi\x1bOPthere')).toBe('hithere');
  });

  it('strips CSI sequences with parameters and intermediates', () => {
    // `\x1b[1;32m` (SGR — color) is a legitimate CSI with params
    expect(stripEscapeSequences('\x1b[1;32mhello\x1b[0m')).toBe('hello');
  });

  it('preserves all plain ASCII characters, including special ones', () => {
    const s = 'a1!@#$%^&*()_+-={}|:<>?,./~`';
    expect(stripEscapeSequences(s)).toBe(s);
  });

  it('preserves newlines and other non-escape control bytes (they are handled downstream)', () => {
    const input = 'abc\ndef\t';
    expect(stripEscapeSequences(input)).toBe('abc\ndef\t');
  });

  it('leaves a trailing lone ESC (no follow byte) for the raw-mode loop to drop', () => {
    // No follow byte = no complete Fe sequence. The bare ESC passes
    // through our regex; the raw-mode <0x20 filter in readOneLine
    // drops it downstream.
    expect(stripEscapeSequences('abc\x1b')).toBe('abc\x1b');
  });

  it('treats ESC + any 0x40-0x7E byte as a two-byte Fe escape (swallows both)', () => {
    // ESC + "b" (0x62) matches the Fe branch of the regex — we intentionally
    // drop both bytes rather than let "b" survive as visible input.
    expect(stripEscapeSequences('a\x1bb')).toBe('a');
  });

  it('handles multiple back-to-back escape sequences', () => {
    const input = '\x1b[200~\x1b[1msecret\x1b[0m\x1b[201~';
    expect(stripEscapeSequences(input)).toBe('secret');
  });
});
