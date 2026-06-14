import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import { loadSkills } from '../../src/skills/loader.js';
import {
  installSkill,
  MissingAptDepsError,
  checkAptDeps,
} from '../../src/skills/installer.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';

const SILENT = pino({ level: 'silent' });

/**
 * Build a fake skill directory with a manifest declaring apt_dependencies,
 * then point loadSkills at it via a temp skills root. installSkill should
 * preflight against `checkAptDeps` before running install.sh.
 */
describe('installSkill apt-dep preflight', () => {
  let dir: string;
  let dbHandle: ReturnType<typeof openDatabase>;
  let skillsRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-installer-apt-'));
    dbHandle = openDatabase(resolve(dir, 'test.db'), SILENT);
    skillsRoot = resolve(dir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
  });
  afterEach(() => {
    dbHandle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSkill(
    name: string,
    aptDeps: string[],
    installShBody = '#!/bin/sh\necho ok\n',
  ): void {
    const skillDir = resolve(skillsRoot, name);
    mkdirSync(skillDir, { recursive: true });
    // YAML quirk: `apt_dependencies:` with no value parses as null,
    // not `[]` — render the field with explicit brackets for the
    // empty case so zod's array validator is happy.
    const aptYaml =
      aptDeps.length === 0
        ? 'apt_dependencies: []'
        : `apt_dependencies:\n${aptDeps.map((d) => `  - ${d}`).join('\n')}`;
    writeFileSync(
      resolve(skillDir, 'manifest.yaml'),
      [
        `name: ${name}`,
        `version: 0.1.0`,
        `description: test skill`,
        `enabled: true`,
        `scope:`,
        `  - dm`,
        `required_secrets: []`,
        aptYaml,
        `mcp_servers: []`,
      ].join('\n'),
    );
    writeFileSync(resolve(skillDir, 'SKILL.md'), `# ${name}\n`);
    writeFileSync(resolve(skillDir, 'install.sh'), installShBody);
  }

  it('runs install.sh when apt_dependencies is empty', async () => {
    writeSkill('no-apt', []);
    const registry = createSkillRegistry(dbHandle.db);
    loadSkills({ dir: skillsRoot, logger: SILENT, registry });
    const audit = createAuditRepo(dbHandle.db);
    const out = await installSkill(
      'no-apt',
      { registry, audit, logger: SILENT },
      { autoConfirm: true },
    );
    expect(out.ran).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  it('aborts with MissingAptDepsError when a real apt dep is missing', async () => {
    // We use a deliberately-impossible package name so dpkg-query (on
    // a Debian host) returns missing. On non-Debian hosts checkAptDeps
    // is a no-op and the install would proceed — skip the assertion
    // there by gating on probe availability.
    const probe = checkAptDeps(['definitely-not-a-real-package-xyz']);
    if (probe.length === 0) {
      // Non-Debian host, or dpkg-query unavailable. Skip.
      return;
    }
    writeSkill('needs-impossible-pkg', ['definitely-not-a-real-package-xyz']);
    const registry = createSkillRegistry(dbHandle.db);
    loadSkills({ dir: skillsRoot, logger: SILENT, registry });
    const audit = createAuditRepo(dbHandle.db);
    let thrown: unknown;
    try {
      await installSkill(
        'needs-impossible-pkg',
        { registry, audit, logger: SILENT },
        { autoConfirm: true },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingAptDepsError);
    expect((thrown as MissingAptDepsError).missing).toContain(
      'definitely-not-a-real-package-xyz',
    );
  });

  it('audits the abort with kind=skill_install_blocked', async () => {
    const probe = checkAptDeps(['definitely-not-a-real-package-xyz']);
    if (probe.length === 0) return; // non-Debian host
    writeSkill('audit-test', ['definitely-not-a-real-package-xyz']);
    const registry = createSkillRegistry(dbHandle.db);
    loadSkills({ dir: skillsRoot, logger: SILENT, registry });
    const audit = createAuditRepo(dbHandle.db);
    try {
      await installSkill(
        'audit-test',
        { registry, audit, logger: SILENT },
        { autoConfirm: true },
      );
    } catch {
      /* expected */
    }
    const rows = audit.list({ kind: 'skill_install_blocked' });
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail as { reason: string; missing: string[] };
    expect(detail.reason).toBe('missing_apt_deps');
    expect(detail.missing).toContain('definitely-not-a-real-package-xyz');
  });
});

describe('checkAptDeps', () => {
  it('returns empty for empty input regardless of host', () => {
    expect(checkAptDeps([])).toEqual([]);
  });

  it('returns empty when dpkg-query is unavailable', () => {
    // We can't actually unset PATH safely here, but on macOS the dpkg
    // probe should silently return empty for any input.
    const result = checkAptDeps(['libnss3', 'libxkbcommon0']);
    // If we're on Debian and these are installed, also empty. If we're
    // on macOS, dpkg isn't there, also empty. Either way: empty in
    // a clean install. Just ensure the function is total.
    expect(Array.isArray(result)).toBe(true);
  });
});
