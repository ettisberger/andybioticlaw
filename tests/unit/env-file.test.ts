import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readEnvFile, writeEnvFileUpdates } from '../../src/config/env-file.js';

describe('env-file reader/writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-env-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(contents: string): string {
    const p = resolve(dir, '.env');
    writeFileSync(p, contents);
    return p;
  }

  it('readEnvFile returns empty values when file is missing', () => {
    const out = readEnvFile(resolve(dir, 'nonexistent'));
    expect(out.values).toEqual({});
    expect(out.lines).toEqual([]);
  });

  it('parses simple KEY=VALUE lines and strips matching quotes', () => {
    const p = write(`FOO=bar\nBAZ="quoted"\nQUX='single'\n# a comment\n`);
    const out = readEnvFile(p);
    expect(out.values).toEqual({ FOO: 'bar', BAZ: 'quoted', QUX: 'single' });
    // lines preserved
    expect(out.lines).toHaveLength(4);
    expect(out.lines[2]).toBe("QUX='single'");
  });

  it('updates existing keys in place — preserves surrounding comments', () => {
    const p = write(
      '# --- section 1 ---\nFOO=old\nBAR=untouched\n# --- section 2 ---\nQUX=q\n',
    );
    const result = writeEnvFileUpdates(p, { FOO: 'new' });
    expect(result.updated).toEqual(['FOO']);
    expect(result.appended).toEqual([]);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('# --- section 1 ---\n');
    expect(after).toContain('# --- section 2 ---\n');
    expect(after).toContain('FOO=new');
    expect(after).not.toContain('FOO=old');
    expect(after).toContain('BAR=untouched');
  });

  it('appends missing keys at the end', () => {
    const p = write('FOO=a\nBAR=b\n');
    const result = writeEnvFileUpdates(p, { NEW_KEY: 'n' });
    expect(result.updated).toEqual([]);
    expect(result.appended).toEqual(['NEW_KEY']);
    const after = readFileSync(p, 'utf8');
    expect(after.endsWith('NEW_KEY=n\n')).toBe(true);
  });

  it('quotes values that contain whitespace or special chars', () => {
    const p = write('');
    writeEnvFileUpdates(p, {
      A: 'plain',
      B: 'has space',
      C: 'with "quotes"',
      D: '#leading-hash',
    });
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('A=plain\n');
    expect(after).toContain('B="has space"\n');
    expect(after).toContain('C="with \\"quotes\\""\n');
    expect(after).toContain('D="#leading-hash"\n');
  });

  it('file mode is 0600 after write', () => {
    const p = write('FOO=bar\n');
    writeEnvFileUpdates(p, { FOO: 'baz' });
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes ALWAYS end with a trailing newline', () => {
    const p = write('FOO=a');   // no trailing newline on purpose
    writeEnvFileUpdates(p, { FOO: 'b' });
    const after = readFileSync(p, 'utf8');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('round-trips a realistic .env through read → write', () => {
    const original = `# core secrets
TELEGRAM_BOT_TOKEN=abc
DASHBOARD_BASIC_AUTH_PASSWORD=""

# email
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_USER=me@example.com
SMTP_PASS="has space"
SMTP_FROM=me@example.com
IMAP_HOST=imap.fastmail.com
IMAP_PORT=993
`;
    const p = write(original);
    const parsed = readEnvFile(p);
    expect(parsed.values.TELEGRAM_BOT_TOKEN).toBe('abc');
    expect(parsed.values.DASHBOARD_BASIC_AUTH_PASSWORD).toBe('');
    expect(parsed.values.SMTP_PASS).toBe('has space');

    // Now update one and confirm everything else is intact.
    writeEnvFileUpdates(p, { SMTP_FROM: 'new-from@example.com' });
    const updated = readEnvFile(p);
    expect(updated.values.SMTP_FROM).toBe('new-from@example.com');
    expect(updated.values.SMTP_HOST).toBe('smtp.fastmail.com');
    expect(updated.values.TELEGRAM_BOT_TOKEN).toBe('abc');
    const raw = readFileSync(p, 'utf8');
    expect(raw).toContain('# core secrets\n');
    expect(raw).toContain('# email\n');
  });
});
