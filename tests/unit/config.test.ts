import { describe, it, expect } from 'vitest';
import { Config, HOT_RELOADABLE_PATHS, RESTART_REQUIRED_PATHS } from '../../src/config/schema.js';
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('config schema', () => {
  const examplePath = resolve(__dirname, '..', '..', 'config', 'config.example.yaml');
  const raw = readFileSync(examplePath, 'utf8');
  const parsed = yaml.load(raw);

  it('accepts config.example.yaml', () => {
    const result = Config.safeParse(parsed);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it('rejects an unknown model ID pattern', () => {
    const bad = structuredClone(parsed as Record<string, unknown>);
    const agents = bad.agents as Record<string, unknown>[];
    agents[0]!.model = 'gpt-4o';
    const result = Config.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range heartbeat interval', () => {
    const bad = structuredClone(parsed as Record<string, unknown>);
    (bad.observability as Record<string, unknown>).heartbeatIntervalSec = 0;
    const result = Config.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects malformed dailyResetTime', () => {
    const bad = structuredClone(parsed as Record<string, unknown>);
    (bad.budget as Record<string, unknown>).dailyResetTime = '9am';
    const result = Config.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('has no path both hot-reloadable and restart-required', () => {
    const overlap = HOT_RELOADABLE_PATHS.filter((p) =>
      (RESTART_REQUIRED_PATHS as readonly string[]).includes(p),
    );
    expect(overlap).toEqual([]);
  });
});
