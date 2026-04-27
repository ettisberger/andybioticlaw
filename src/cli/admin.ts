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
import { createSchedulesRepo } from '../db/repositories/schedules.js';
import { createBudgetStateRepo } from '../db/repositories/budget-state.js';
import { createSessionsRepo } from '../db/repositories/sessions.js';
import { createBudgetTracker } from '../agent/budget.js';
import { parsePayload, ScheduleKind } from '../scheduler/payloads.js';
import { evaluateScheduleKindGate } from './commands/schedule-gate.js';
import cron from 'node-cron';
import pino from 'pino';
import { WizardAbortedError } from './wizard.js';
import { runSkillSetup, SkillSetupError } from './skill-setup.js';
import { defaultEnvPath } from '../config/paths.js';

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

// --- init ----------------------------------------------------------------
program
  .command('init')
  .description('Interactive first-time setup: populate .env and config.yaml.')
  .action(async () => {
    const { runInitCommand } = await import('./init.js');
    try {
      await runInitCommand();
    } catch (e) {
      if (e instanceof WizardAbortedError) {
        process.stderr.write('\ninit aborted.\n');
        process.exit(130);
      }
      process.stderr.write(`\ninit failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

// --- update --------------------------------------------------------------
program
  .command('update')
  .description('Pull latest source, rebuild backend + frontend, prune dev deps.')
  .action(async () => {
    const { runUpdateCommand } = await import('./update.js');
    try {
      await runUpdateCommand();
    } catch (e) {
      process.stderr.write(`\nupdate failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

// --- doctor --------------------------------------------------------------
program
  .command('doctor')
  .description('Read-only health check: config, DB, auth, telegram, dashboard, skills, schedules, disk, logs, budget.')
  .option('--json', 'machine-readable JSON output')
  .option('-v, --verbose', 'include detail lines under each row')
  .option('-c, --config <path>', 'override config file path')
  .action(async (opts: { json?: boolean; verbose?: boolean; config?: string }) => {
    const { runDoctor } = await import('./commands/doctor.js');
    try {
      const exitCode = await runDoctor({
        json: !!opts.json,
        verbose: !!opts.verbose,
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      });
      process.exit(exitCode);
    } catch (e) {
      process.stderr.write(`\ndoctor failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

// --- config ---------------------------------------------------------------
const config = program.command('config').description('Inspect, edit, and reload configuration');

config
  .command('edit')
  .description('Interactively edit the most-tweaked config.yaml fields (model, budget, retention, …).')
  .action(async () => {
    const { runSettingsCommand } = await import('./settings/run.js');
    try {
      await runSettingsCommand();
    } catch (e) {
      process.stderr.write(`\nedit failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

// Top-level alias so `andybioticlaw settings` is discoverable too.
program
  .command('settings')
  .description('Alias for `config edit` — interactive settings editor.')
  .action(async () => {
    const { runSettingsCommand } = await import('./settings/run.js');
    try {
      await runSettingsCommand();
    } catch (e) {
      process.stderr.write(`\nedit failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

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
            setupWizard: rec.setupWizard ?? null,
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
  .option(
    '-y, --yes',
    'skip the interactive y/N preview confirmation (use in non-interactive flows where install.sh has been reviewed out-of-band)',
  )
  .action(async (name: string, opts: { yes?: boolean }) => {
    const { config, dbHandle, logger } = openRuntime();
    try {
      const registry = createSkillRegistry(dbHandle.db);
      const audit = createAuditRepo(dbHandle.db);
      loadSkills({ dir: expandPath(config.skills.dir, projectRoot()), logger, registry });
      const out = await installSkill(
        name,
        { registry, audit, logger },
        { autoConfirm: !!opts.yes },
      );
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
  .command('setup')
  .description(
    'Run the skill setup wizard (collects env vars interactively, then runs install.sh).',
  )
  .argument('[name]', 'skill name; if omitted, lists skills with a wizard')
  .option('--no-install', 'collect values only, skip install.sh')
  .option('--no-sighup', "don't SIGHUP the running daemon after install")
  .action(
    async (
      name: string | undefined,
      opts: { install?: boolean; sighup?: boolean },
    ) => {
      const { config, dataDir, dbHandle, logger } = openRuntime();
      try {
        const registry = createSkillRegistry(dbHandle.db);
        const audit = createAuditRepo(dbHandle.db);
        loadSkills({
          dir: expandPath(config.skills.dir, projectRoot()),
          logger,
          registry,
        });

        if (!name) {
          const withWizard = registry.list().filter((s) => s.setupWizard);
          if (withWizard.length === 0) {
            process.stdout.write('(no installed skills declare a setup wizard)\n');
            return;
          }
          process.stdout.write(
            'Skills with a setup wizard:\n' +
              withWizard
                .map(
                  (s) =>
                    `  • ${s.name}@${s.version}  — ${s.setupWizard!.description}`,
                )
                .join('\n') +
              '\n\nRun:  andybioticlaw skill setup <name>\n',
          );
          return;
        }

        const skill = registry.get(name);
        if (!skill) {
          process.stderr.write(`no skill named ${name}\n`);
          process.exit(1);
        }

        try {
          await runSkillSetup({
            skill,
            registry,
            audit,
            logger,
            envPath: defaultEnvPath(projectRoot()),
            dataDir,
            runInstall: opts.install !== false,
            sighup: opts.sighup !== false,
          });
        } catch (e) {
          if (e instanceof SkillSetupError) {
            process.stderr.write(`${e.message}\n`);
            const code =
              e.stage === 'wizard-aborted'
                ? 130
                : e.stage === 'no-wizard'
                  ? 2
                  : 3;
            process.exit(code);
          }
          throw e;
        }
      } finally {
        dbHandle.close();
      }
    },
  );

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

// --- schedule -------------------------------------------------------------
const schedule = program.command('schedule').description('Manage scheduled tasks');

function sendSighupIfRunning(dataDir: string): void {
  const pidPath = pidFilePath(dataDir);
  if (!existsSync(pidPath)) return;
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) return;
  try {
    process.kill(pid, 'SIGHUP');
    process.stdout.write(`(SIGHUP sent to running daemon pid ${pid} — schedule refresh queued)\n`);
  } catch {
    /* daemon probably not running — fine, it'll pick up on next start */
  }
}

schedule
  .command('list')
  .description('List all schedules')
  .action(() => {
    const { dbHandle } = openRuntime();
    try {
      const repo = createSchedulesRepo(dbHandle.db);
      const rows = repo.list();
      if (rows.length === 0) {
        process.stdout.write('(no schedules defined)\n');
        return;
      }
      for (const r of rows) {
        const flag = r.enabled ? '✓' : '✗';
        const budget = r.budget_tokens_per_day
          ? `  budget=${r.budget_used_today}/${r.budget_tokens_per_day}`
          : '';
        const fails = r.consecutive_fails > 0 ? `  fails=${r.consecutive_fails}` : '';
        const last = r.last_run ? `  last=${formatTs(r.last_run)}` : '';
        process.stdout.write(
          `${flag} #${r.id}  ${r.name}  [${r.kind}]  cron='${r.cron_expr}'${budget}${fails}${last}\n`,
        );
      }
    } finally {
      dbHandle.close();
    }
  });

schedule
  .command('show')
  .description('Show a schedule plus recent runs')
  .argument('<id>')
  .option('-n, --limit <n>', 'recent-runs limit', '10')
  .action((idStr: string, opts: { limit: string }) => {
    const id = Number(idStr);
    const { dbHandle } = openRuntime();
    try {
      const repo = createSchedulesRepo(dbHandle.db);
      const row = repo.get(id);
      if (!row) {
        process.stderr.write(`no schedule with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(row, null, 2) + '\n');
      process.stdout.write(`\n--- recent runs (last ${opts.limit}) ---\n`);
      const runs = repo.listRuns(id, Number(opts.limit));
      if (runs.length === 0) {
        process.stdout.write('(no runs yet)\n');
        return;
      }
      for (const run of runs) {
        const started = formatTs(run.started_at);
        const dur = run.ended_at ? `${run.ended_at - run.started_at}ms` : '—';
        process.stdout.write(
          `  ${started}  ${run.status}  ${dur}  tokens=${run.tokens_used}\n`,
        );
        if (run.output) {
          const head = run.output.length > 200 ? run.output.slice(0, 200) + '…' : run.output;
          process.stdout.write(`    ${head.replace(/\n/g, '\n    ')}\n`);
        }
      }
    } finally {
      dbHandle.close();
    }
  });

schedule
  .command('add')
  .description('Create a new schedule')
  .requiredOption('-n, --name <name>', 'unique schedule name')
  .option('-c, --cron <expr>', 'cron expression (5- or 6-field) — use this OR --at, not both')
  .option(
    '--at <iso>',
    'fire once at this local timestamp (YYYY-MM-DDTHH:MM). Implies --once.',
  )
  .requiredOption('-k, --kind <kind>', 'bash | http-check | agent-task | reminder')
  .requiredOption('-p, --payload <json>', 'kind-specific JSON payload')
  .option(
    '--once',
    'one-shot: fire once at the next cron match then delete. Use with --cron for "tonight at 23:00" style pinned expressions.',
  )
  .option('-b, --budget <tokens>', 'per-day token budget (agent-task / triggered chains)')
  .option('--disabled', 'create disabled')
  .action(
    (opts: {
      name: string;
      cron?: string;
      at?: string;
      kind: string;
      payload: string;
      once?: boolean;
      budget?: string;
      disabled?: boolean;
    }) => {
      // --at and --cron are mutually exclusive; exactly one is required.
      if (opts.at && opts.cron) {
        process.stderr.write(`use either --at or --cron, not both\n`);
        process.exit(2);
      }
      if (!opts.at && !opts.cron) {
        process.stderr.write(`one of --at or --cron is required\n`);
        process.exit(2);
      }

      let cronExpr: string;
      let recurring = !opts.once;
      if (opts.at) {
        const parsed = parseAtTimestamp(opts.at);
        if (!parsed) {
          process.stderr.write(
            `invalid --at "${opts.at}" — expected ISO local timestamp like 2026-04-22T15:30\n`,
          );
          process.exit(2);
        }
        if (parsed.getTime() <= Date.now()) {
          process.stderr.write(
            `--at "${opts.at}" is in the past — reminder would never fire\n`,
          );
          process.exit(2);
        }
        cronExpr = cronFromDate(parsed);
        recurring = false; // --at is always one-shot
      } else {
        cronExpr = opts.cron!;
      }

      if (!cron.validate(cronExpr)) {
        process.stderr.write(`invalid cron expression: "${cronExpr}"\n`);
        process.exit(2);
      }
      const kindRes = ScheduleKind.safeParse(opts.kind);
      if (!kindRes.success) {
        process.stderr.write(
          `invalid kind "${opts.kind}" — must be one of: bash, http-check, agent-task, reminder\n`,
        );
        process.exit(2);
      }
      try {
        parsePayload(kindRes.data, opts.payload);
      } catch (e) {
        process.stderr.write(`payload invalid: ${(e as Error).message}\n`);
        process.exit(2);
      }

      // Agent gate. Emma can shell out to this CLI, so a prompt injection
      // could otherwise talk her into creating `--kind bash` schedules
      // that run arbitrary shell commands as the service user.
      //
      // The gate:
      //   - With ANDYBIOTICLAW_AGENT_CAN_BASH=1 set: anything goes (the
      //     principal is acting directly via their shell).
      //   - Without it: only `reminder` + `agent-task` allowed (Emma's
      //     self-service surface — agent-task just re-runs Emma with a
      //     prompt, same risk profile as a normal DM). `bash` and
      //     `http-check` stay principal-only.
      //   - `agent-task` is also capped at AGENT_TASK_SCHEDULE_CAP active
      //     rows so a hostile prompt can't loop Emma into mass-creating.
      //
      // See `evaluateScheduleKindGate` for the matrix.
      const agentCanBash = process.env.ANDYBIOTICLAW_AGENT_CAN_BASH === '1';
      let agentTaskCount = 0;
      if (kindRes.data === 'agent-task' && !agentCanBash) {
        const { dbHandle } = openRuntime();
        try {
          const repo = createSchedulesRepo(dbHandle.db);
          agentTaskCount = repo.list().filter((s) => s.kind === 'agent-task').length;
        } finally {
          dbHandle.close();
        }
      }
      const gate = evaluateScheduleKindGate({
        kind: kindRes.data,
        agentCanBash,
        agentTaskCount,
      });
      if (!gate.ok) {
        const { dbHandle } = openRuntime();
        try {
          const auditRepo = createAuditRepo(dbHandle.db);
          auditRepo.record({
            kind: 'schedule_kind_gate_blocked',
            actor: 'cli',
            detail: {
              attemptedKind: kindRes.data,
              name: opts.name,
              cron: cronExpr,
              reason: gate.reason,
            },
          });
        } finally {
          dbHandle.close();
        }
        process.stderr.write(
          `refusing to create schedule of kind "${kindRes.data}": ${gate.reason}\n` +
            `If you (the principal) really want this, prefix the command:\n` +
            `  ANDYBIOTICLAW_AGENT_CAN_BASH=1 andybioticlaw schedule add ...\n`,
        );
        process.exit(3);
      }

      const { dbHandle, dataDir } = openRuntime();
      try {
        const repo = createSchedulesRepo(dbHandle.db);
        const auditRepo = createAuditRepo(dbHandle.db);
        if (repo.getByName(opts.name)) {
          process.stderr.write(`schedule named "${opts.name}" already exists\n`);
          process.exit(1);
        }
        const row = repo.create({
          name: opts.name,
          cron_expr: cronExpr,
          kind: kindRes.data,
          payload: opts.payload,
          enabled: !opts.disabled,
          recurring,
          budget_tokens_per_day: opts.budget ? Number(opts.budget) : null,
        });
        // When the gate flag is unset, this CLI call almost certainly
        // originated from the agent (the principal's interactive shell
        // would have it exported). Log that for post-hoc inspection —
        // even harmless `reminder` creations are worth tracing.
        if (!agentCanBash) {
          auditRepo.record({
            kind: 'schedule_created_by_agent',
            actor: 'cli',
            detail: {
              id: row.id,
              name: row.name,
              kind: row.kind,
              cron: row.cron_expr,
              recurring,
            },
          });
        }
        const tag = recurring ? '' : '  (one-shot)';
        process.stdout.write(
          `created #${row.id}  ${row.name}  [${row.kind}]  cron='${row.cron_expr}'${tag}${row.enabled ? '' : '  (disabled)'}\n`,
        );
        sendSighupIfRunning(dataDir);
      } finally {
        dbHandle.close();
      }
    },
  );

/**
 * Parse an ISO-ish local timestamp like "2026-04-22T15:30" or
 * "2026-04-22 15:30" into a Date. Rejects anything containing a timezone
 * suffix ("Z", "+02:00") — for those, the caller should pass a cron expr
 * directly. Returns null on any parse/validity failure.
 */
function parseAtTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) return null;
  const m = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  if (Number.isNaN(date.getTime())) return null;
  // Validate round-trip — guards against e.g. month=13 silently normalizing.
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return null;
  }
  return date;
}

/**
 * Cron expression that fires exactly once at the given local date. Pinned
 * minute + hour + day + month; day-of-week wildcarded (node-cron requires
 * at least one of DoM/DoW — pinned DoM is enough).
 */
function cronFromDate(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

schedule
  .command('remove')
  .description('Delete a schedule (irreversible)')
  .argument('<id>')
  .action((idStr: string) => {
    const id = Number(idStr);
    const { dbHandle, dataDir } = openRuntime();
    try {
      const repo = createSchedulesRepo(dbHandle.db);
      const ok = repo.remove(id);
      if (!ok) {
        process.stderr.write(`no schedule with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`removed #${id}\n`);
      sendSighupIfRunning(dataDir);
    } finally {
      dbHandle.close();
    }
  });

schedule
  .command('enable')
  .description('Enable a schedule (clears auto-disable state)')
  .argument('<id>')
  .action((idStr: string) => {
    const id = Number(idStr);
    const { dbHandle, dataDir } = openRuntime();
    try {
      const repo = createSchedulesRepo(dbHandle.db);
      if (!repo.get(id)) {
        process.stderr.write(`no schedule with id ${id}\n`);
        process.exit(1);
      }
      // Clear consecutive_fails so the loop-protection doesn't immediately
      // re-disable on the next fire.
      repo.update(id, { enabled: true, consecutive_fails: 0 });
      process.stdout.write(`enabled #${id}\n`);
      sendSighupIfRunning(dataDir);
    } finally {
      dbHandle.close();
    }
  });

schedule
  .command('disable')
  .description('Disable a schedule')
  .argument('<id>')
  .action((idStr: string) => {
    const id = Number(idStr);
    const { dbHandle, dataDir } = openRuntime();
    try {
      const repo = createSchedulesRepo(dbHandle.db);
      if (!repo.get(id)) {
        process.stderr.write(`no schedule with id ${id}\n`);
        process.exit(1);
      }
      repo.update(id, { enabled: false });
      process.stdout.write(`disabled #${id}\n`);
      sendSighupIfRunning(dataDir);
    } finally {
      dbHandle.close();
    }
  });

schedule
  .command('run')
  .description(
    'Run a schedule NOW, out-of-band. Requires the daemon to be running for agent-task / reminder kinds.',
  )
  .argument('<id>')
  .action((idStr: string) => {
    const id = Number(idStr);
    const { dataDir } = openRuntime();
    const pidPath = pidFilePath(dataDir);
    if (!existsSync(pidPath)) {
      process.stderr.write(
        `daemon not running — bash and http-check can be tested via \`schedule show ${id}\` + \`sh -c <command>\`\n`,
      );
      process.exit(3);
    }
    // Signal via an SIGUSR1 + a one-off DB flag? Cleaner: send SIGHUP with
    // a "run-now" intent written to a small file. Keep it simple for v1:
    // document that `schedule run` is a developer convenience — the
    // scheduler picks up the change on refresh and fires on the next
    // cron tick. For an immediate manual fire, disable then enable and
    // wait, or use a one-minute cron like `* * * * *` for ad-hoc runs.
    process.stdout.write(
      `schedule "${id}" will fire on its next cron tick. For immediate dev use, set its cron to '* * * * *' temporarily.\n`,
    );
    void id;
  });

// --- remaining stubs for later phases ------------------------------------
const NOT_YET = 'not yet implemented — see CHANGELOG.md';
const stub = (name: string, summary: string) => {
  program
    .command(name)
    .description(`${summary} (phase ≥5)`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      process.stderr.write(`${name}: ${NOT_YET}\n`);
      process.exit(64);
    });
};

stub('status', 'Show service status summary');
stub('session', 'Session inspection and control');
stub('secrets', 'List declared secrets (names only)');
stub('audit', 'Show audit log entries');
stub('db', 'DB utilities');

// --- budget ---------------------------------------------------------------
// The daily token budget is a SOFT spend-guard — it's our own limit, not
// Anthropic's. `show` prints current state; `reset` shifts the effective
// window start to "now" so the counter is zeroed until the next natural
// daily reset rolls past the anchor.

const budget = program.command('budget').description('Inspect or reset the soft daily token budget');

budget
  .command('show')
  .description('Print the current daily-budget status')
  .action(() => {
    const { config, dbHandle } = openRuntime();
    try {
      const sessionsRepo = createSessionsRepo(dbHandle.db);
      const stateRepo = createBudgetStateRepo(dbHandle.db);
      const tracker = createBudgetTracker(
        sessionsRepo,
        () => ({
          dailyTokenLimit: config.budget.dailyTokenLimit,
          perSessionTokenLimit: config.budget.perSessionTokenLimit,
          dailyResetTime: config.budget.dailyResetTime,
          timezone: config.service.timezone,
        }),
        stateRepo,
      );
      const s = tracker.status();
      process.stdout.write(
        `used:      ${s.used.toLocaleString()} / ${s.dailyLimit.toLocaleString()} tokens\n`,
      );
      process.stdout.write(`remaining: ${s.remaining.toLocaleString()}\n`);
      process.stdout.write(`exhausted: ${s.exhausted ? 'YES' : 'no'}\n`);
      process.stdout.write(`window:    ${formatTs(s.window.fromMs)} → ${formatTs(s.window.toMs)}\n`);
      if (s.window.manualResetAt !== null) {
        process.stdout.write(
          `manual reset active since ${formatTs(s.window.manualResetAt)} (overrides natural window start)\n`,
        );
      }
    } finally {
      dbHandle.close();
    }
  });

budget
  .command('reset')
  .description('Zero the daily-budget counter by anchoring its window to now. Intended as a manual override for the principal.')
  .action(async () => {
    const { config, dbHandle } = openRuntime();
    let before: ReturnType<ReturnType<typeof createBudgetTracker>['status']>;
    let after: typeof before;
    let now: number;
    try {
      const sessionsRepo = createSessionsRepo(dbHandle.db);
      const stateRepo = createBudgetStateRepo(dbHandle.db);
      const auditRepo = createAuditRepo(dbHandle.db);
      const tracker = createBudgetTracker(
        sessionsRepo,
        () => ({
          dailyTokenLimit: config.budget.dailyTokenLimit,
          perSessionTokenLimit: config.budget.perSessionTokenLimit,
          dailyResetTime: config.budget.dailyResetTime,
          timezone: config.service.timezone,
        }),
        stateRepo,
      );
      before = tracker.status();
      now = Date.now();
      stateRepo.setResetAnchor(now);
      auditRepo.record({
        kind: 'budget_reset',
        actor: 'cli',
        detail: {
          previousUsed: before.used,
          previousRemaining: before.remaining,
          anchorMs: now,
        },
      });
      after = tracker.status();
      process.stdout.write(
        `budget reset: ${before.used.toLocaleString()} → ${after.used.toLocaleString()} used (limit ${after.dailyLimit.toLocaleString()})\n`,
      );
      process.stdout.write(
        `window anchor now: ${formatTs(now)} — natural reset still at ${formatTs(after.window.nextResetMs)}\n`,
      );
    } finally {
      dbHandle.close();
    }

    // Best-effort principal-DM. Budget-reset is a sensitive operation —
    // Emma can trigger it (prompt-injection risk), so the principal
    // wants to see it immediately. We POST directly to Telegram's HTTP
    // API (no grammy dep needed here) using the bot token from .env
    // and the first allowed DM user id as the chat id. All failures
    // are non-fatal: the reset already happened, the audit row is
    // written, the DM is just a notification.
    try {
      await notifyPrincipalOfBudgetReset({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: config.telegram.dm.allowedUserIds[0],
        previousUsed: before.used,
        limit: after.dailyLimit,
        timezone: config.service.timezone,
      });
    } catch (e) {
      process.stderr.write(
        `(note: principal-DM failed: ${(e as Error).message} — audit row still written)\n`,
      );
    }
  });

async function notifyPrincipalOfBudgetReset(opts: {
  botToken: string | undefined;
  chatId: number | undefined;
  previousUsed: number;
  limit: number;
  timezone: string;
}): Promise<void> {
  if (!opts.botToken) {
    process.stderr.write(
      `(note: TELEGRAM_BOT_TOKEN not set — skipping principal-DM)\n`,
    );
    return;
  }
  if (opts.chatId === undefined) {
    process.stderr.write(
      `(note: no allowedUserIds configured — skipping principal-DM)\n`,
    );
    return;
  }
  const text =
    `⚠️ Budget was reset.\n` +
    `Previous usage: ${opts.previousUsed.toLocaleString()} / ${opts.limit.toLocaleString()} tokens (${opts.timezone}).\n` +
    `If you didn't run this yourself, check the audit log (kind=budget_reset) — the service agent can reach this CLI too.`;
  const res = await fetch(
    `https://api.telegram.org/bot${opts.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: opts.chatId, text }),
    },
  );
  if (!res.ok) {
    throw new Error(`telegram sendMessage returned ${res.status}`);
  }
}

// If invoked without any subcommand (`andybioticlaw` alone), drop into the
// interactive TUI menu instead of printing Commander's help block. Lets
// operators run `sudo -iu andybioticlaw` and hit the menu immediately.
// process.argv[0] is node, [1] is the script path; length === 2 means
// nothing after that. Any subcommand or flag → fall through to Commander
// as before.
async function main(): Promise<void> {
  if (process.argv.length === 2) {
    const { runInteractiveMenu } = await import('./menu.js');
    await runInteractiveMenu();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((e) => {
  process.stderr.write(`CLI error: ${(e as Error).message}\n`);
  process.exit(1);
});
