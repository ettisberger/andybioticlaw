import { describe, it, expect } from 'vitest';
import { isValidBotToken } from '../../src/cli/init.js';

/**
 * Bot token format check — the wizard's inline validation. A
 * malformed token here means the operator pasted the wrong thing
 * (a memory of a token, a placeholder, an api key from another
 * service). We want to catch this BEFORE saving to .env so the
 * service doesn't 401 at first /getUpdates with the failure
 * buried in pino logs.
 */

describe('isValidBotToken', () => {
  it('accepts BotFather-shaped tokens', () => {
    // Real-world examples (digits-bot-id : 35-char alphanum suffix
    // with `-` / `_` allowed).
    expect(isValidBotToken('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz0123456')).toBe(true);
    expect(isValidBotToken('123456:Abc-def_GHI_jkl-MNO_pqr-stu-vwx-y')).toBe(true);
    // Longer suffixes still pass (Telegram has rotated lengths).
    expect(
      isValidBotToken('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz0123456789ABCdef'),
    ).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBotToken('')).toBe(false);
  });

  it('rejects suffix shorter than 30 chars', () => {
    expect(isValidBotToken('1234567890:short')).toBe(false);
    expect(isValidBotToken('1234567890:abcdefghijklmno')).toBe(false);
  });

  it('rejects bot id that is too short (less than 6 digits)', () => {
    expect(isValidBotToken('123:ABCdefGHIjklMNOpqrsTUVwxyz0123456')).toBe(false);
  });

  it('rejects suffix with disallowed characters', () => {
    expect(isValidBotToken('1234567890:!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')).toBe(false);
    expect(isValidBotToken('1234567890:abc def ghi jkl mno pqr stu vw')).toBe(false);
  });

  it('rejects missing colon separator', () => {
    expect(isValidBotToken('1234567890ABCdefGHIjklMNOpqrsTUVwxyz0123456')).toBe(false);
  });

  it('rejects bot id that is non-numeric', () => {
    expect(isValidBotToken('abcdef:ABCdefGHIjklMNOpqrsTUVwxyz0123456')).toBe(false);
  });

  it('rejects an Anthropic OAuth token (the other kind of token operators paste)', () => {
    expect(
      isValidBotToken(
        'sk-ant-oat01-AbcDefGhiJklMnoPqrStuVwxYz0123456789AbcDefGhiJklMnoPqr',
      ),
    ).toBe(false);
  });
});
