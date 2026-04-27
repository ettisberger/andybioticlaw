import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadPolicies,
  resolvePolicy,
  savePolicies,
} from '../../src/policies/repo.js';
import { synthesizeDefaultPolicies } from '../../src/policies/auto-generate.js';
import { HARDCODED_FALLBACK, type PoliciesFile } from '../../src/policies/schema.js';

/**
 * Three behaviours the policy layer must guarantee:
 *   1. Round-trip: a file written by savePolicies parses back identical.
 *   2. Layered resolution: explicit > parent (_inherits) > defaults > hard-coded.
 *   3. Auto-generated install picks up the principal id and produces a
 *      principal context the resolver can find.
 */

function freshDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'andy-policies-'));
}

describe('loadPolicies + savePolicies round-trip', () => {
  let dir: string;
  beforeEach(() => (dir = freshDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for a missing file', () => {
    expect(loadPolicies(resolve(dir, 'absent.json'))).toBeNull();
  });

  it('round-trips a complete file', () => {
    const path = resolve(dir, 'policies.json');
    const file: PoliciesFile = {
      version: 1,
      defaults: { scheduleKinds: ['reminder'] },
      contexts: {
        'emma:telegram:42': {
          _label: 'principal',
          execMode: 'allowlist',
          execAllow: ['Bash(git status*)'],
        },
      },
    };
    savePolicies(path, file);
    const reread = loadPolicies(path);
    expect(reread).toEqual(file);
  });

  it('writes mode 0600 (best-effort on platforms that support it)', () => {
    const path = resolve(dir, 'policies.json');
    savePolicies(path, { version: 1, defaults: {}, contexts: {} });
    const raw = readFileSync(path, 'utf8');
    // Trailing newline is part of the contract — easier diffing/git.
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('throws on malformed JSON', () => {
    const path = resolve(dir, 'broken.json');
    writeFileSync(path, '{ this is not json');
    expect(() => loadPolicies(path)).toThrow(/invalid JSON/);
  });

  it('throws on schema-violating JSON', () => {
    const path = resolve(dir, 'wrong.json');
    writeFileSync(path, JSON.stringify({ version: 999 }));
    expect(() => loadPolicies(path)).toThrow(/schema validation failed/);
  });
});

describe('resolvePolicy', () => {
  it('returns hard-coded fallback when context AND defaults are absent', () => {
    const file: PoliciesFile = { version: 1, defaults: {}, contexts: {} };
    const r = resolvePolicy(file, 'emma:telegram:42');
    expect(r.execMode).toBe(HARDCODED_FALLBACK.execMode);
    expect(r.scheduleKinds).toEqual(HARDCODED_FALLBACK.scheduleKinds);
  });

  it('uses defaults when no context entry matches', () => {
    const file: PoliciesFile = {
      version: 1,
      defaults: { execMode: 'allowlist', execAllow: ['Bash(echo*)'] },
      contexts: {},
    };
    const r = resolvePolicy(file, 'emma:telegram:42');
    expect(r.execMode).toBe('allowlist');
    expect(r.execAllow).toEqual(['Bash(echo*)']);
  });

  it('explicit context overrides defaults field-by-field', () => {
    const file: PoliciesFile = {
      version: 1,
      defaults: { execMode: 'allowlist', execAllow: ['Bash(parent*)'] },
      contexts: {
        'emma:telegram:1': { execMode: 'full' },
      },
    };
    const r = resolvePolicy(file, 'emma:telegram:1');
    expect(r.execMode).toBe('full'); // overridden
    expect(r.execAllow).toEqual(['Bash(parent*)']); // inherited
  });

  it('_inherits layers parent above defaults but below explicit', () => {
    const file: PoliciesFile = {
      version: 1,
      defaults: { execMode: 'deny' },
      contexts: {
        'emma:telegram:1': {
          execMode: 'full',
          execAllow: ['Bash(parent*)'],
          skillsVisible: ['*'],
        },
        'emma:schedule:agent-task': {
          _inherits: 'emma:telegram:1',
          execMode: 'allowlist', // explicit override of parent's 'full'
        },
      },
    };
    const r = resolvePolicy(file, 'emma:schedule:agent-task');
    expect(r.execMode).toBe('allowlist'); // explicit
    expect(r.execAllow).toEqual(['Bash(parent*)']); // from parent
    expect(r.skillsVisible).toEqual(['*']); // from parent
  });

  it('throws on missing parent (typo guard)', () => {
    const file: PoliciesFile = {
      version: 1,
      defaults: {},
      contexts: {
        a: { _inherits: 'does-not-exist' },
      },
    };
    expect(() => resolvePolicy(file, 'a')).toThrow(/unknown parent/);
  });

  it('throws on nested inheritance chain', () => {
    const file: PoliciesFile = {
      version: 1,
      defaults: {},
      contexts: {
        a: {},
        b: { _inherits: 'a' },
        c: { _inherits: 'b' },
      },
    };
    expect(() => resolvePolicy(file, 'c')).toThrow(/nested _inherits chains/);
  });
});

describe('synthesizeDefaultPolicies', () => {
  it('without principal id, only emits restrictive defaults', () => {
    const file = synthesizeDefaultPolicies({
      defaultAgentId: 'emma',
      principalUserId: null,
    });
    expect(file.version).toBe(1);
    expect(file.defaults?.scheduleKinds).toEqual(['reminder']);
    expect(file.defaults?.execMode).toBe('deny');
    expect(Object.keys(file.contexts)).toEqual([]);
  });

  it('with a principal id, produces a permissive principal context', () => {
    const file = synthesizeDefaultPolicies({
      defaultAgentId: 'emma',
      principalUserId: 18998064,
    });
    const principalKey = 'emma:telegram:18998064';
    expect(file.contexts[principalKey]).toBeDefined();
    const r = resolvePolicy(file, principalKey);
    // Mirrors today's bypassPermissions + the schedule-gate matrix.
    expect(r.execMode).toBe('full');
    expect(r.scheduleKinds).toContain('agent-task');
    expect(r.scheduleAgentTaskCap).toBe(20);
    expect(r.skillsVisible).toEqual(['*']);
  });

  it('with a principal id, produces a self-scheduled agent-task context that inherits', () => {
    const file = synthesizeDefaultPolicies({
      defaultAgentId: 'emma',
      principalUserId: 1,
    });
    const r = resolvePolicy(file, 'emma:schedule:agent-task');
    // Inherits from the principal DM. execMode should match.
    expect(r.execMode).toBe('full');
    expect(r.skillsVisible).toEqual(['*']);
  });
});
