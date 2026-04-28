import { describe, it, expect } from 'vitest';
import {
  isHotReloadable,
  isRestartRequired,
} from '../../src/config/schema.js';

/**
 * Pin the per-agent path classification. Adding a second agent must NOT
 * require a schema.ts edit to pick up correct hot-reload / restart-
 * required behaviour for `agents.1.haikuModel` etc.
 */

describe('isHotReloadable', () => {
  it('returns true for static hot-reloadable paths', () => {
    expect(isHotReloadable('service.logLevel')).toBe(true);
    expect(isHotReloadable('observability.heartbeatIntervalSec')).toBe(true);
    expect(isHotReloadable('memory.autoAccept')).toBe(true);
  });

  it('returns true for the default agent (index 0)', () => {
    expect(isHotReloadable('agents.0.haikuModel')).toBe(true);
    expect(isHotReloadable('agents.0.routing.enabled')).toBe(true);
    expect(isHotReloadable('agents.0.routing.minCharsForOpus')).toBe(true);
  });

  it('returns true for any agent index — no schema edit needed for agent #2', () => {
    expect(isHotReloadable('agents.1.haikuModel')).toBe(true);
    expect(isHotReloadable('agents.7.routing.enabled')).toBe(true);
    expect(isHotReloadable('agents.99.routing.minCharsForOpus')).toBe(true);
  });

  it('returns false for restart-required paths', () => {
    expect(isHotReloadable('service.timezone')).toBe(false);
    expect(isHotReloadable('agents.0.model')).toBe(false);
    expect(isHotReloadable('agents.3.skills')).toBe(false);
  });

  it('returns false for unknown paths', () => {
    expect(isHotReloadable('agents.0.unknownField')).toBe(false);
    expect(isHotReloadable('not.a.real.path')).toBe(false);
  });
});

describe('isRestartRequired', () => {
  it('returns true for static restart-required paths', () => {
    expect(isRestartRequired('service.timezone')).toBe(true);
    expect(isRestartRequired('telegram.dm.allowedUserIds')).toBe(true);
    expect(isRestartRequired('dashboard.basicAuth.enabled')).toBe(true);
  });

  it('returns true for any agent index for restart-required fields', () => {
    expect(isRestartRequired('agents.0.model')).toBe(true);
    expect(isRestartRequired('agents.0.skills')).toBe(true);
    expect(isRestartRequired('agents.5.credentialsDir')).toBe(true);
    expect(isRestartRequired('agents.5.tokenEnvVar')).toBe(true);
    expect(isRestartRequired('agents.5.systemPromptFile')).toBe(true);
  });

  it('returns false for hot-reloadable paths', () => {
    expect(isRestartRequired('agents.0.haikuModel')).toBe(false);
    expect(isRestartRequired('agents.7.routing.enabled')).toBe(false);
    expect(isRestartRequired('memory.autoAccept')).toBe(false);
  });

  it('returns false for unknown paths', () => {
    expect(isRestartRequired('agents.0.unknownField')).toBe(false);
    expect(isRestartRequired('not.a.real.path')).toBe(false);
  });
});
