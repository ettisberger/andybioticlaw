import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pino } from 'pino';
import Database from 'better-sqlite3';
import { checkClaudeCredentials } from '../../src/agent/credentials.js';
import type { AuthMethod } from '../../src/agent/credentials.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';
import { createEventBus } from '../../src/events/bus.js';
import { createErrorReporter } from '../../src/observability/errors.js';

/**
 * End-to-end-ish tests for `checkClaudeCredentials`: we swap the `claude`
 * binary for a shell-script stub whose stdout we control, so the real
 * JSON-parse + reject-list + authMethod branches execute against a known
 * payload. This covers what a mocked `execFile` wouldn't — the actual
 * shape of our CLI invocation (`claude auth status --json`) + parse.
 */
describe('checkClaudeCredentials — reject-list + authMethod', () => {
  let stubDir: string;
  let savedToken: string | undefined;

  function makeDeps(claudeBin: string) {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT,
        detail TEXT
      );
    `);
    const audit = createAuditRepo(db);
    const bus = createEventBus();
    const logger = pino({ level: 'silent' });
    const errors = createErrorReporter(bus, logger);
    return {
      credentialsDir: stubDir, // irrelevant for these tests; just needs to be a path
      logger,
      bus,
      audit,
      errors,
      claudeBin,
    };
  }

  function writeStubClaude(responseJson: Record<string, unknown>): string {
    const body = JSON.stringify(responseJson);
    const script = `#!/bin/sh
# Ignore all args ("auth status --json") and print the fixed JSON response.
cat <<'EOF'
${body}
EOF
`;
    const path = resolve(stubDir, 'claude-stub.sh');
    writeFileSync(path, script, 'utf8');
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'abl-creds-test-'));
    savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    try {
      rmSync(stubDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('session path: apiKeySource=none + subscriptionType=pro → ok, authMethod "session"', async () => {
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeySource: 'none',
      subscriptionType: 'pro',
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(true);
    expect((result.details?.['authMethod'] as AuthMethod)).toBe('session');
    expect(result.details?.['unknownApiKeySourceWarning']).toBeUndefined();
  });

  it('rejects apiKeySource=ANTHROPIC_API_KEY (pay-as-you-go)', async () => {
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeySource: 'ANTHROPIC_API_KEY',
      subscriptionType: null,
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/API-key billing/i);
    expect(result.details?.['apiKeySource']).toBe('ANTHROPIC_API_KEY');
  });

  it('rejects apiKeySource=ANTHROPIC_AUTH_TOKEN (also API-billing pattern)', async () => {
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
      subscriptionType: null,
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/API-key billing/i);
  });

  it('token path: CLI reports authMethod="oauth_token" + null subscriptionType → ok, authMethod "token"', async () => {
    // Empirically verified on CLI 2.1.x: when CLAUDE_CODE_OAUTH_TOKEN is
    // live, `claude auth status --json` returns apiKeySource="none" AND
    // authMethod="oauth_token" AND subscriptionType=null. The service
    // must accept this without rejecting on the missing tier.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-subscription-bound-token';
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiKeySource: 'none',
      subscriptionType: null,
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(true);
    expect((result.details?.['authMethod'] as AuthMethod)).toBe('token');
    // `claudeAuthMethod` preserves the CLI's raw label for observability.
    expect(result.details?.['claudeAuthMethod']).toBe('oauth_token');
  });

  it('unknown path: non-oauth_token authMethod + non-reject apiKeySource → ok, authMethod "unknown", warning set', async () => {
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeySource: 'some-future-cli-source',
      subscriptionType: 'pro',
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(true);
    expect((result.details?.['authMethod'] as AuthMethod)).toBe('unknown');
    expect(result.details?.['unknownApiKeySourceWarning']).toBe(
      'some-future-cli-source',
    );
  });

  it('rejects session mode when subscriptionType is null (not logged in via subscription)', async () => {
    // session mode = authMethod !== "oauth_token", so the tier gate applies.
    const bin = writeStubClaude({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeySource: 'none',
      subscriptionType: null,
    });
    const result = await checkClaudeCredentials(makeDeps(bin));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no subscription tier/i);
  });
});
