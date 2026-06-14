import { describe, it, expect } from 'vitest';
import { buildMemoryMcpEnv } from '../../src/agent/session.js';

describe('buildMemoryMcpEnv', () => {
  const fixture = {
    dbPath: '/home/andybioticlaw/.andybioticlaw/data/andybioticlaw.db',
    sessionId: 'sess-1',
    chatId: '12345',
    configPath: '/home/andybioticlaw/.andybioticlaw/config/config.yaml',
  };

  it('threads the canonical env vars through verbatim', () => {
    const env = buildMemoryMcpEnv(fixture);
    expect(env.ANDYBIOTICLAW_DB_PATH).toBe(fixture.dbPath);
    expect(env.ANDYBIOTICLAW_SESSION_ID).toBe(fixture.sessionId);
    expect(env.ANDYBIOTICLAW_CHAT_ID).toBe(fixture.chatId);
    expect(env.ANDYBIOTICLAW_CONFIG_PATH).toBe(fixture.configPath);
  });

  it('PLAYWRIGHT_BROWSERS_PATH = <dataDir>/cache/playwright (no off-by-one)', () => {
    // Regression for fix(browser): PLAYWRIGHT_BROWSERS_PATH used to
    // walk dirname() twice on dbPath under the false assumption that
    // the DB lived at `<dataDir>/db/…`. That put the path one level
    // above dataDir and silently broke the runtime browser launch.
    // sqliteDbPath() puts the DB directly under dataDir.
    const env = buildMemoryMcpEnv(fixture);
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(
      '/home/andybioticlaw/.andybioticlaw/data/cache/playwright',
    );
  });

  it('respects an arbitrary dbPath shape', () => {
    const env = buildMemoryMcpEnv({
      ...fixture,
      dbPath: '/tmp/test-install/data/andybioticlaw.db',
    });
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(
      '/tmp/test-install/data/cache/playwright',
    );
  });

  it('forwards PATH / HOME / NODE_ENV from the parent process', () => {
    const env = buildMemoryMcpEnv(fixture);
    // PATH must be present so node can find binaries when an MCP
    // server shells out (e.g. the himalaya skill's exec_allow targets).
    expect(typeof env.PATH).toBe('string');
    // HOME and NODE_ENV are forwarded as strings even when unset
    // (default to '' / 'production' respectively).
    expect(typeof env.HOME).toBe('string');
    expect(typeof env.NODE_ENV).toBe('string');
  });
});
