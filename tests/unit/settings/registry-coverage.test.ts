import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildSettingsRegistry } from '../../../src/cli/settings/registry.js';
import { SETTINGS_LAYOUT } from '../../../src/cli/settings/layout.js';
import type { SettingsContext } from '../../../src/cli/settings/types.js';

/**
 * Structural coverage for the Settings menu.
 *
 * Catches the class of bug where a regex (in registry.ts) silently
 * fails to match after a YAML refactor and `read()` falls back to a
 * default — the row keeps rendering, just with the wrong value.
 *
 * The test runs every setting declared in SETTINGS_LAYOUT against the
 * shipped `config/config.example.yaml` and asserts the rendered row
 * matches an expectation table. Extending the menu means extending the
 * table — a deliberate forcing function so new settings can't be
 * added without a verification anchor.
 */

const projectRoot = resolve(__dirname, '..', '..', '..');
const examplePath = resolve(projectRoot, 'config', 'config.example.yaml');
const exampleYaml = readFileSync(examplePath, 'utf8');

type Expectation =
  | { kind: 'bool'; checked: boolean }
  | { kind: 'meta'; metaIncludes?: string }
  | { kind: 'present' }; // just verify it renders without throwing

/**
 * Expected render for every setting against the shipped example yaml.
 * - `bool`: toggleable; `checked` must match the example's value
 * - `meta`: value row; `metaIncludes` (if set) must appear in the meta string
 * - `present`: action / external-state setting; just verify it renders
 */
const EXPECTATIONS: Record<string, Expectation> = {
  'memory.autoAccept': { kind: 'bool', checked: true },
  'agent.model': { kind: 'meta', metaIncludes: 'claude-opus-4-7' },
  'service.logLevel': { kind: 'meta', metaIncludes: 'info' },
  'telegram.conversationHistoryLimit': { kind: 'meta', metaIncludes: '50' },
  'agent.routing.enabled': { kind: 'bool', checked: false },
  'agent.haikuModel': { kind: 'meta', metaIncludes: 'claude-haiku' },
  'agent.routing.minCharsForOpus': { kind: 'meta', metaIncludes: '120' },
  // Integers render with thousand separators (e.g. "2,000,000").
  'budget.dailyTokenLimit': { kind: 'meta', metaIncludes: '2,000,000' },
  'budget.perSessionTokenLimit': { kind: 'meta', metaIncludes: '200,000' },
  'messages.retentionDays': { kind: 'meta' },
  'telegram.allowedUserIds': { kind: 'meta' },
  // voice.enabled reads from the SQLite voice_state repo; tested in menu-flow.
  'voice.enabled': { kind: 'present' },
  'voice.groqKey': { kind: 'meta' },
  'voice.test': { kind: 'present' },
  'dashboard.enabled': { kind: 'bool', checked: true },
  'dashboard.basicAuth.enabled': { kind: 'bool', checked: true },
  'dashboard.basicAuth.passwordHash': { kind: 'meta' },
  'agents.show': { kind: 'present' },
  'policies.show': { kind: 'present' },
};

function makeCtx(): SettingsContext {
  return {
    stdin: {} as never,
    stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    configPath: examplePath,
    envPath: '/tmp/.env',
    voiceState: {
      getEnabled: () => false,
      setEnabled: () => {},
    } as unknown as SettingsContext['voiceState'],
    readYaml: () => exampleYaml,
    writeYaml: vi.fn(),
    readEnv: () => ({}),
    writeEnv: vi.fn(),
  };
}

describe('settings registry — coverage against config.example.yaml', () => {
  const registry = buildSettingsRegistry();
  const ctx = makeCtx();

  it('every layout id has a registry entry', () => {
    const layoutIds = SETTINGS_LAYOUT.flatMap((s) => s.settingIds);
    for (const id of layoutIds) {
      expect(registry.has(id), `layout references unknown setting "${id}"`).toBe(
        true,
      );
    }
  });

  it('every layout id is covered by an expectation', () => {
    const layoutIds = SETTINGS_LAYOUT.flatMap((s) => s.settingIds);
    for (const id of layoutIds) {
      expect(
        Object.prototype.hasOwnProperty.call(EXPECTATIONS, id),
        `layout id "${id}" has no expectation in registry-coverage.test.ts`,
      ).toBe(true);
    }
  });

  for (const [id, exp] of Object.entries(EXPECTATIONS)) {
    it(`renders ${id} correctly against the example yaml`, () => {
      const component = registry.get(id);
      expect(component, `registry missing ${id}`).toBeDefined();
      const row = component!.renderRow(ctx);
      if (exp.kind === 'bool') {
        expect(row.checked, `${id}.checked`).toBe(exp.checked);
      } else if (exp.kind === 'meta') {
        expect(typeof row.meta, `${id}.meta type`).toBe('string');
        expect((row.meta ?? '').length, `${id}.meta non-empty`).toBeGreaterThan(0);
        if (exp.metaIncludes) {
          expect(row.meta, `${id}.meta`).toContain(exp.metaIncludes);
        }
      }
      // 'present' — calling renderRow without throwing is the assertion.
    });
  }
});
