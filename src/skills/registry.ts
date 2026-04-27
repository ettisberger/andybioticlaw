import type { Database } from 'better-sqlite3';
import type { SkillManifest } from './manifest.js';

export interface SkillRecord {
  name: string;
  version: string;
  description: string;
  /** Effective enable state (DB override if present, else manifest.enabled). */
  enabled: boolean;
  scope: readonly ('dm' | 'group')[];
  requiredSecrets: readonly string[];
  aptDependencies: readonly string[];
  systemCommands: readonly string[];
  mcpServers: SkillManifest['mcp_servers'];
  /** Bash-tool patterns the skill needs allowed in the agent session.
   *  Merged into `.claude/settings.json` per-session at session-start
   *  by the harness (step 4 of the multi-agent refactor). */
  execAllow: readonly string[];
  /** Setup-wizard definition (for `andybioticlaw skill setup <name>`), if any. */
  setupWizard?: SkillManifest['setup_wizard'];
  manifestPath: string;
  skillMdPath: string;
  skillDir: string;
}

export interface SkillRegistry {
  list(): SkillRecord[];
  get(name: string): SkillRecord | undefined;
  register(record: SkillRecord): void;
  unregister(name: string): boolean;
  /** Flat lookup: { skillName → requiredSecrets[] }. For secrets scoping. */
  requiredSecretsTable(): ReadonlyMap<string, ReadonlyArray<string>>;
  /** Currently-enabled skills in the given session scope. */
  activeFor(sessionScope: 'dm' | 'group'): SkillRecord[];
  /** Persist enable/disable in skill_state. */
  setEnabled(name: string, enabled: boolean): void;
  /** Record an install (idempotent). */
  recordInstall(name: string, output: string | null): void;
  /** Read persisted skill_state incl. last install output. Null when unseen. */
  getState(name: string): SkillStateFull | null;
}

export interface SkillState {
  name: string;
  enabled: boolean;
  installed_at: number;
}

export interface SkillStateFull extends SkillState {
  last_install_output: string | null;
  last_enabled_at: number | null;
  last_disabled_at: number | null;
}

export function createSkillRegistry(db: Database): SkillRegistry {
  const table = new Map<string, SkillRecord>();

  const selectState = db.prepare<{ name: string }, SkillState>(
    `SELECT name, enabled, installed_at FROM skill_state WHERE name = @name`,
  );

  const selectStateFull = db.prepare<{ name: string }, SkillStateFull>(
    `SELECT name, enabled, installed_at,
            last_install_output, last_enabled_at, last_disabled_at
     FROM skill_state WHERE name = @name`,
  );

  const upsertInstall = db.prepare<{
    name: string;
    enabled: number;
    installed_at: number;
    last_install_output: string | null;
  }>(
    `INSERT INTO skill_state (name, enabled, installed_at, last_install_output)
     VALUES (@name, @enabled, @installed_at, @last_install_output)
     ON CONFLICT(name) DO UPDATE SET last_install_output = excluded.last_install_output`,
  );

  const seedState = db.prepare<{
    name: string;
    enabled: number;
    installed_at: number;
  }>(
    `INSERT INTO skill_state (name, enabled, installed_at)
     VALUES (@name, @enabled, @installed_at)
     ON CONFLICT(name) DO NOTHING`,
  );

  const setEnabledStmt = db.prepare<{ name: string; enabled: number; ts: number }>(
    `UPDATE skill_state
     SET enabled = @enabled,
         last_enabled_at = CASE WHEN @enabled = 1 THEN @ts ELSE last_enabled_at END,
         last_disabled_at = CASE WHEN @enabled = 0 THEN @ts ELSE last_disabled_at END
     WHERE name = @name`,
  );

  function applyPersistedState(record: SkillRecord): SkillRecord {
    // Ensure a state row exists so later setEnabled() calls can update it.
    seedState.run({
      name: record.name,
      enabled: record.enabled ? 1 : 0,
      installed_at: Date.now(),
    });
    const state = selectState.get({ name: record.name });
    if (state) {
      return { ...record, enabled: Boolean(state.enabled) };
    }
    return record;
  }

  return {
    list: () => Array.from(table.values()),
    get: (name) => table.get(name),
    register: (record) => {
      table.set(record.name, applyPersistedState(record));
    },
    unregister: (name) => table.delete(name),
    requiredSecretsTable() {
      const out = new Map<string, ReadonlyArray<string>>();
      for (const s of table.values()) out.set(s.name, s.requiredSecrets);
      return out;
    },
    activeFor(sessionScope) {
      return Array.from(table.values()).filter(
        (s) => s.enabled && s.scope.includes(sessionScope),
      );
    },
    setEnabled(name, enabled) {
      setEnabledStmt.run({ name, enabled: enabled ? 1 : 0, ts: Date.now() });
      const existing = table.get(name);
      if (existing) table.set(name, { ...existing, enabled });
    },
    recordInstall(name, output) {
      const existing = selectState.get({ name });
      upsertInstall.run({
        name,
        enabled: existing ? (existing.enabled ? 1 : 0) : 1,
        installed_at: existing ? existing.installed_at : Date.now(),
        last_install_output: output,
      });
    },
    getState(name) {
      const row = selectStateFull.get({ name });
      if (!row) return null;
      // SQLite returns 0/1 for BOOL columns; normalise to boolean.
      return { ...row, enabled: Boolean(row.enabled) };
    },
  };
}
