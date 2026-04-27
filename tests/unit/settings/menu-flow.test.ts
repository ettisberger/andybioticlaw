import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createVoiceStateRepo } from '../../../src/db/repositories/voice-state.js';
import { buildSettingsRegistry } from '../../../src/cli/settings/registry.js';
import { SETTINGS_LAYOUT } from '../../../src/cli/settings/layout.js';
import type { SettingsContext } from '../../../src/cli/settings/types.js';

/**
 * End-to-end-ish integration test: drive the settings registry
 * directly by id, asserting disk + db state after each simulated
 * action. Doesn't exercise the arrowPicker stdin handling (that's
 * terminal-tight and flaky in tests), but it DOES exercise the full
 * registry → component → yaml/env/sqlite path on real files. Combined
 * with the renderer.test.ts routing test, this locks both axes:
 *   - picker index → id mapping is correct (renderer.test.ts)
 *   - id → handler mutates the right state (this file)
 */

const MIN_YAML = `
service:
  dataDir: /tmp/does-not-matter
  logLevel: info
  timezone: UTC
agents:
  - id: emma
    name: test
    default: true
    model: claude-opus-4-7
    streamIdleTimeoutSec: 120
    skills: ['*']
bindings: []
telegram:
  dm:
    allowedUserIds: [123]
    runMode: workspace
    workspaceBase: /tmp
  group:
    allowedGroupIds: []
    runMode: workspace
    workspaceBase: /tmp
  streamEditIntervalMs: 1200
  longTaskNotifyAfterMs: 45000
  conversationHistoryLimit: 50
  voice:
    maxDurationSec: 120
    language: auto
budget:
  dailyTokenLimit: 2000000
  perSessionTokenLimit: 200000
  perScheduleDefault: 100000
  dailyResetTime: "00:00"
memory:
  autoAccept: true
  defaultScopes: ["global"]
  ttlCleanupCron: "0 3 * * *"
messages:
  retentionDays: null
dashboard:
  enabled: true
  host: 127.0.0.1
  port: 18790
  basicAuth:
    enabled: false
    username: admin
    passwordHash: ''
observability:
  heartbeatIntervalSec: 60
  heartbeatRetentionDays: 30
  errorsToTelegram: false
  errorChatIdOverride: null
skills:
  dir: ./skills
  autoLoadOnStart: true
`;

function setupTmpDirs() {
  const dir = mkdtempSync(resolve(tmpdir(), 'andy-settings-'));
  const configPath = resolve(dir, 'config.yaml');
  const envPath = resolve(dir, '.env');
  writeFileSync(configPath, MIN_YAML);
  writeFileSync(envPath, '');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE voice_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO voice_state (id, enabled, updated_at) VALUES (1, 0, 1000);
  `);
  const voiceState = createVoiceStateRepo(db);
  return { dir, configPath, envPath, db, voiceState };
}

function makeCtxForTmp(paths: ReturnType<typeof setupTmpDirs>): SettingsContext {
  return {
    stdin: {} as never,
    stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    configPath: paths.configPath,
    envPath: paths.envPath,
    voiceState: paths.voiceState,
    readYaml: () => readFileSync(paths.configPath, 'utf8'),
    writeYaml: (body) => writeFileSync(paths.configPath, body),
    readEnv: () => {
      const text = readFileSync(paths.envPath, 'utf8');
      const out: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]!] = m[2]!;
      }
      return out;
    },
    writeEnv: (updates) => {
      const current = readFileSync(paths.envPath, 'utf8').split('\n');
      const existingKeys = new Set<string>();
      const next: string[] = [];
      for (const line of current) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=.*/);
        if (m && updates[m[1]!] !== undefined) {
          next.push(`${m[1]!}=${updates[m[1]!]!}`);
          existingKeys.add(m[1]!);
        } else {
          next.push(line);
        }
      }
      for (const [k, v] of Object.entries(updates)) {
        if (!existingKeys.has(k)) next.push(`${k}=${v}`);
      }
      writeFileSync(paths.envPath, next.join('\n'));
    },
  };
}

describe('settings menu flow — id-routed handleSelect end-to-end', () => {
  it('memory.autoAccept toggle flips the yaml and flips back', async () => {
    const paths = setupTmpDirs();
    try {
      const ctx = makeCtxForTmp(paths);
      const registry = buildSettingsRegistry();
      const setting = registry.get('memory.autoAccept')!;

      expect(ctx.readYaml()).toMatch(/autoAccept:\s*true/);
      const first = await setting.handleSelect(ctx);
      expect(first.changed).toBe(true);
      expect(ctx.readYaml()).toMatch(/autoAccept:\s*false/);

      await setting.handleSelect(ctx);
      expect(ctx.readYaml()).toMatch(/autoAccept:\s*true/);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it('dashboard.enabled toggle patches only the dashboard.enabled line, not basicAuth.enabled', async () => {
    const paths = setupTmpDirs();
    try {
      const ctx = makeCtxForTmp(paths);
      const registry = buildSettingsRegistry();
      const before = ctx.readYaml();
      expect(before).toMatch(/dashboard:\s*\n  enabled:\s*true/);
      expect(before).toMatch(/basicAuth:\s*\n    enabled:\s*false/);

      await registry.get('dashboard.enabled')!.handleSelect(ctx);

      const after = ctx.readYaml();
      expect(after).toMatch(/dashboard:\s*\n  enabled:\s*false/);
      // basic-auth must be untouched — the two `enabled:` lines must NOT cross-contaminate.
      expect(after).toMatch(/basicAuth:\s*\n    enabled:\s*false/);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it('voice.enabled refuses to enable when GROQ_API_KEY is unset', async () => {
    const paths = setupTmpDirs();
    try {
      const ctx = makeCtxForTmp(paths);
      const registry = buildSettingsRegistry();

      expect(paths.voiceState.getEnabled()).toBe(false);
      const result = await registry.get('voice.enabled')!.handleSelect(ctx);
      expect(result.changed).toBe(false);
      expect(paths.voiceState.getEnabled()).toBe(false);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it('voice.enabled allows enable once GROQ_API_KEY is set; disable always works', async () => {
    const paths = setupTmpDirs();
    try {
      writeFileSync(paths.envPath, 'GROQ_API_KEY=gsk_test\n');
      const ctx = makeCtxForTmp(paths);
      const registry = buildSettingsRegistry();

      // Enable: allowed now.
      const enableResult = await registry.get('voice.enabled')!.handleSelect(ctx);
      expect(enableResult.changed).toBe(true);
      expect(paths.voiceState.getEnabled()).toBe(true);

      // Disable: always allowed.
      const disableResult = await registry.get('voice.enabled')!.handleSelect(ctx);
      expect(disableResult.changed).toBe(true);
      expect(paths.voiceState.getEnabled()).toBe(false);
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  });

  it('every layout id resolves in the registry (no orphaned layout rows)', () => {
    // Guard against layout.ts listing an id that registry.ts forgot to wire.
    // The renderer silently skips missing ids, so this is the guard against
    // a silent-drop regression when we add new settings.
    const registry = buildSettingsRegistry();
    for (const section of SETTINGS_LAYOUT) {
      for (const id of section.settingIds) {
        expect(registry.has(id), `missing registry entry for layout id "${id}"`).toBe(true);
      }
    }
  });
});
