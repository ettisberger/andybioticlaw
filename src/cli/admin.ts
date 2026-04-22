#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { Command } from 'commander';
import { bootstrapEnv, loadConfig, ConfigLoadError, projectRoot } from '../config/load.js';
import { expandPath, pidFilePath, sqliteDbPath } from '../config/paths.js';
import { openDatabase } from '../db/index.js';
import { createAuditRepo } from '../db/repositories/audit.js';
import { createMemoryRepo } from '../db/repositories/memory.js';
import { createMemoryManager } from '../memory/manager.js';
import { createSkillRegistry } from '../skills/registry.js';
import { loadSkills } from '../skills/loader.js';
import { installSkill, uninstallSkill } from '../skills/installer.js';
import pino from 'pino';

const program = new Command();

program
  .name('andybioticlaw')
  .description('andybioticlaw — personal AI agent service admin CLI')
  .version('0.1.0');

// --- shared helpers -------------------------------------------------------

function openRuntime(opts?: { configPath?: string }) {
  bootstrapEnv();
  const loaded = loadConfig(opts?.configPath);
  const dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
  const logger = pino({ level: 'warn' });
  const dbHandle = openDatabase(sqliteDbPath(dataDir), logger);
  return { config: loaded.config, dataDir, dbHandle, logger };
}

function formatTs(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

// --- config ---------------------------------------------------------------
const config = program.command('config').description('Inspect and reload configuration');

config
  .command('validate')
  .description('Load config/config.yaml and validate against the schema')
  .option('-c, --config <path>', 'override config file path')
  .action((opts: { config?: string }) => {
    bootstrapEnv();
    try {
      const result = loadConfig(opts.config);
      process.stdout.write(`OK — config valid: ${result.configPath}\n`);
      process.stdout.write(
        `  agent: ${result.config.agent.name}  model: ${result.config.agent.model}\n`,
      );
      process.stdout.write(`  dataDir: ${result.config.service.dataDir}\n`);
      process.exit(0);
    } catch (e) {
      if (e instanceof ConfigLoadError) {
        process.stderr.write(`FAIL — ${e.kind}\n\n${e.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`FAIL — ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

config
  .command('reload')
  .description('Send SIGHUP to the running daemon to re-read config')
  .action(() => {
    bootstrapEnv();
    let dataDir: string;
    try {
      const loaded = loadConfig();
      dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
    } catch (e) {
      process.stderr.write(`cannot determine dataDir: ${(e as Error).message}\n`);
      process.exit(2);
    }
    const pidPath = pidFilePath(dataDir);
    if (!existsSync(pidPath)) {
      process.stderr.write(`no pidfile at ${pidPath} — is the daemon running?\n`);
      process.exit(3);
    }
    const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isNaN(pid)) {
      process.stderr.write(`invalid pidfile contents at ${pidPath}\n`);
      process.exit(3);
    }
    try {
      process.kill(pid, 'SIGHUP');
      process.stdout.write(`SIGHUP sent to pid ${pid}\n`);
    } catch (e) {
      process.stderr.write(`failed to signal pid ${pid}: ${(e as Error).message}\n`);
      process.exit(4);
    }
  });

// --- memory ---------------------------------------------------------------
const memory = program.command('memory').description('Inspect and edit agent memory');

memory
  .command('list')
  .description('List memory entries (optionally filtered by scope)')
  .option('-s, --scope <scope>', 'filter to a single scope')
  .option('-l, --limit <n>', 'max rows', '100')
  .action((opts: { scope?: string; limit: string }) => {
    const { dbHandle, logger } = openRuntime();
    try {
      const repo = createMemoryRepo(dbHandle.db);
      const manager = createMemoryManager({ repo, logger });
      const rows = opts.scope
        ? manager.listByScope(opts.scope, Number(opts.limit))
        : manager.listAll(Number(opts.limit));
      if (rows.length === 0) {
        process.stdout.write('(no entries)\n');
        return;
      }
      for (const r of rows) {
        const ttl = r.ttl_at ? `  ttl=${formatTs(r.ttl_at)}` : '';
        const keyPart = r.key ? ` [${r.key}]` : '';
        process.stdout.write(
          `#${r.id}  ${r.scope}${keyPart}  ${r.source}  updated=${formatTs(r.updated_at)}${ttl}\n`,
        );
        process.stdout.write(`    ${r.value}\n`);
      }
    } finally {
      dbHandle.close();
    }
  });

memory
  .command('add')
  .description('Add a memory entry')
  .argument('<scope>', 'memory scope (global | user:<id> | chat:<id> | skill:<name> | custom)')
  .argument('<value...>', 'memory value')
  .option('-k, --key <key>', 'optional key identifier')
  .option('-t, --ttl <seconds>', 'optional TTL in seconds')
  .action(
    (scope: string, valueParts: string[], opts: { key?: string; ttl?: string }) => {
      const { dbHandle, logger } = openRuntime();
      try {
        const repo = createMemoryRepo(dbHandle.db);
        const manager = createMemoryManager({ repo, logger });
        const value = valueParts.join(' ').trim();
        const args: Parameters<typeof manager.addManual>[0] = { scope, value };
        if (opts.key) args.key = opts.key;
        if (opts.ttl) args.ttlSeconds = Number(opts.ttl);
        const entry = manager.addManual(args);
        process.stdout.write(`added #${entry.id}  ${entry.scope}\n    ${entry.value}\n`);
      } catch (e) {
        process.stderr.write(`FAIL — ${(e as Error).message}\n`);
        process.exit(1);
      } finally {
        dbHandle.close();
      }
    },
  );

memory
  .command('remove')
  .description('Delete a memory entry by id')
  .argument('<id>', 'memory entry id')
  .action((idStr: string) => {
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write('invalid id\n');
      process.exit(2);
    }
    const { dbHandle, logger } = openRuntime();
    try {
      const repo = createMemoryRepo(dbHandle.db);
      const manager = createMemoryManager({ repo, logger });
      const ok = manager.remove(id);
      if (!ok) {
        process.stderr.write(`no entry with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`removed #${id}\n`);
    } finally {
      dbHandle.close();
    }
  });

memory
  .command('show')
  .description('Show a memory entry by id')
  .argument('<id>', 'memory entry id')
  .action((idStr: string) => {
    const id = Number(idStr);
    const { dbHandle } = openRuntime();
    try {
      const repo = createMemoryRepo(dbHandle.db);
      const row = repo.get(id);
      if (!row) {
        process.stderr.write(`no entry with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(row, null, 2) + '\n');
    } finally {
      dbHandle.close();
    }
  });

// --- skill ----------------------------------------------------------------
const skill = program.command('skill').description('Inspect and manage installed skills');

skill
  .command('list')
  .description('List registered skills')
  .action(() => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      const rows = registry.list();
      if (rows.length === 0) {
        process.stdout.write('(no skills registered)\n');
        return;
      }
      for (const r of rows) {
        const flag = r.enabled ? '✓' : '✗';
        const scopes = r.scope.join(',');
        process.stdout.write(
          `${flag}  ${r.name}@${r.version}  [${scopes}]  ${r.description}\n`,
        );
      }
    } finally {
      dbHandle.close();
    }
  });

skill
  .command('show')
  .description('Show full details for a skill')
  .argument('<name>')
  .action((name: string) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      const rec = registry.get(name);
      if (!rec) {
        process.stderr.write(`no skill named ${name}\n`);
        process.exit(1);
      }
      process.stdout.write(
        JSON.stringify(
          {
            name: rec.name,
            version: rec.version,
            description: rec.description,
            enabled: rec.enabled,
            scope: rec.scope,
            requiredSecrets: rec.requiredSecrets,
            aptDependencies: rec.aptDependencies,
            systemCommands: rec.systemCommands,
            mcpServers: rec.mcpServers,
            manifestPath: rec.manifestPath,
            skillMdPath: rec.skillMdPath,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      dbHandle.close();
    }
  });

skill
  .command('install')
  .description('Run the skill install.sh (idempotent) and register it')
  .argument('<name>')
  .action(async (name: string) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      const audit = createAuditRepo(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      const out = await installSkill(name, { registry, audit, logger });
      if (!out.ran) {
        process.stdout.write(`skill ${name}: no install.sh — recorded as installed.\n`);
      } else {
        process.stdout.write(`skill ${name}: install.sh exited 0\n${out.stdout}`);
        if (out.stderr) process.stderr.write(out.stderr);
      }
    } catch (e) {
      process.stderr.write(`FAIL — ${(e as Error).message}\n`);
      process.exit(1);
    } finally {
      dbHandle.close();
    }
  });

skill
  .command('uninstall')
  .description('Run the skill uninstall.sh (idempotent)')
  .argument('<name>')
  .action(async (name: string) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      const audit = createAuditRepo(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      const out = await uninstallSkill(name, { registry, audit, logger });
      if (!out.ran) {
        process.stdout.write(`skill ${name}: no uninstall.sh, nothing to run.\n`);
      } else {
        process.stdout.write(`skill ${name}: uninstall.sh exited 0\n${out.stdout}`);
        if (out.stderr) process.stderr.write(out.stderr);
      }
    } catch (e) {
      process.stderr.write(`FAIL — ${(e as Error).message}\n`);
      process.exit(1);
    } finally {
      dbHandle.close();
    }
  });

skill
  .command('enable')
  .description('Enable a skill (persisted; overrides manifest.enabled)')
  .argument('<name>')
  .action((name: string) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      const audit = createAuditRepo(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      if (!registry.get(name)) {
        process.stderr.write(`no skill named ${name}\n`);
        process.exit(1);
      }
      registry.setEnabled(name, true);
      audit.record({ kind: 'skill_enable', actor: 'cli', detail: { name } });
      process.stdout.write(`skill ${name}: enabled\n`);
    } finally {
      dbHandle.close();
    }
  });

skill
  .command('disable')
  .description('Disable a skill (persisted)')
  .argument('<name>')
  .action((name: string) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      const audit = createAuditRepo(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      if (!registry.get(name)) {
        process.stderr.write(`no skill named ${name}\n`);
        process.exit(1);
      }
      registry.setEnabled(name, false);
      audit.record({ kind: 'skill_disable', actor: 'cli', detail: { name } });
      process.stdout.write(`skill ${name}: disabled\n`);
    } finally {
      dbHandle.close();
    }
  });

// --- remaining stubs for later phases ------------------------------------
const NOT_YET = 'not yet implemented in phase 1 — see CHANGELOG.md';
const stub = (name: string, summary: string) => {
  program
    .command(name)
    .description(`${summary} (phase ≥4)`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      process.stderr.write(`${name}: ${NOT_YET}\n`);
      process.exit(64);
    });
};

stub('status', 'Show service status summary');
stub('session', 'Session inspection and control');
stub('schedule', 'Scheduler management');
stub('budget', 'Show daily and monthly token usage');
stub('secrets', 'List declared secrets (names only)');
stub('audit', 'Show audit log entries');
stub('db', 'DB utilities (backup, etc.)');

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
