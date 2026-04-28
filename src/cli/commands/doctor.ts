/**
 * `andybioticlaw doctor` — single read-only health check.
 *
 * Each check returns a row with status (ok/warn/fail/skip) and a one-line
 * detail, optionally with `extras` sub-lines shown only under `--verbose`.
 * The command exits non-zero if ANY row is `fail`. Warnings don't fail.
 *
 * The checks here are intentionally read-only — never mutate config,
 * never restart anything, never write to the DB. Diagnose first; the
 * operator can choose what to fix.
 */

import {
  existsSync,
  statSync,
  accessSync,
  constants,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import type { Database as Db } from 'better-sqlite3';
import pino from 'pino';
import { bootstrapEnv, ConfigLoadError, loadConfig, projectRoot } from '../../config/load.js';
import { getDefaultAgent } from '../../config/agents-helper.js';
import {
  expandPath,
  logsDir,
  pidFilePath,
  policiesPath,
  sqliteDbPath,
} from '../../config/paths.js';
import { loadPolicies, resolvePolicy } from '../../policies/repo.js';
import { contextKey as makeContextKey } from '../../agent/runtime-context.js';
import { openDatabase } from '../../db/index.js';
import { createSkillRegistry } from '../../skills/registry.js';
import { loadSkills } from '../../skills/loader.js';
import { createSchedulesRepo } from '../../db/repositories/schedules.js';
import { createSessionsRepo } from '../../db/repositories/sessions.js';
import { createBudgetTracker } from '../../agent/budget.js';
import { createBudgetStateRepo } from '../../db/repositories/budget-state.js';
import { bold, dim, green, red, yellow, cyan } from '../ansi.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorRow {
  name: string;
  status: DoctorStatus;
  detail: string;
  extras?: string[];
}

export interface DoctorResult {
  rows: DoctorRow[];
  summary: { ok: number; warn: number; fail: number; skip: number };
  exitCode: number;
}

export interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
  configPath?: string;
}

/** Public entry — runs every check, writes to stdout/stderr, returns exit code. */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  // Load .env so the telegram check sees TELEGRAM_BOT_TOKEN and the skill
  // MCP probes inherit the secrets each server expects (CLIENT_IDs etc.).
  bootstrapEnv();
  const result = await collectRows(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.exitCode;
  }

  process.stdout.write(`\n${bold('andybioticlaw doctor')}\n\n`);
  for (const row of result.rows) {
    process.stdout.write(formatRow(row, !!opts.verbose) + '\n');
  }
  process.stdout.write(formatSummary(result.summary) + '\n');
  return result.exitCode;
}

async function collectRows(opts: DoctorOptions): Promise<DoctorResult> {
  const rows: DoctorRow[] = [];

  // Config first — every other check depends on it. If it can't load, we
  // bail with just the one failed row.
  const cfgRow = await checkConfig(opts.configPath);
  rows.push(cfgRow);
  if (cfgRow.status === 'fail') {
    return wrapResult(rows);
  }

  const loaded = loadConfig(opts.configPath);
  const config = loaded.config;
  const dataDir = expandPath(config.service.dataDir, projectRoot());
  const dbPath = sqliteDbPath(dataDir);

  rows.push(await checkDatabase(dbPath));
  rows.push(await checkClaudeAuth(getDefaultAgent(config).credentialsDir));
  rows.push(await checkTelegram(config.telegram.dm.allowedUserIds));
  rows.push(await checkDashboard(config.dashboard));
  rows.push(checkServiceRunning(dataDir));
  rows.push(checkAgents(config));
  rows.push(
    checkPolicies(
      policiesPath(dataDir),
      config.telegram.dm.allowedUserIds[0] ?? null,
    ),
  );

  // For skill / schedule / budget checks we need an open DB.
  let dbHandle: ReturnType<typeof openDatabase> | null = null;
  try {
    dbHandle = openDatabase(dbPath, pino({ level: 'silent' }));
    const skillsResult = await checkSkills(
      expandPath(config.skills.dir, projectRoot()),
      dbHandle.db,
    );
    rows.push(skillsResult);
    rows.push(checkSchedules(dbHandle.db));
    rows.push(checkBudget(dbHandle.db, config));
  } catch (e) {
    rows.push({
      name: 'Skills / Schedules / Budget',
      status: 'fail',
      detail: `could not open DB: ${(e as Error).message}`,
    });
  } finally {
    dbHandle?.close();
  }

  rows.push(checkDisk(dbPath));
  rows.push(checkLogs(logsDir(dataDir)));

  return wrapResult(rows);
}

function wrapResult(rows: DoctorRow[]): DoctorResult {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of rows) summary[r.status]++;
  const exitCode = summary.fail > 0 ? 1 : 0;
  return { rows, summary, exitCode };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatRow(row: DoctorRow, verbose: boolean): string {
  const tag = statusTag(row.status);
  const head = `  ${tag}  ${bold(row.name.padEnd(18))}  ${row.detail}`;
  if (!verbose || !row.extras || row.extras.length === 0) return head;
  return head + '\n' + row.extras.map((e) => `       ${dim(e)}`).join('\n');
}

function statusTag(s: DoctorStatus): string {
  switch (s) {
    case 'ok':
      return green('[✓]');
    case 'warn':
      return yellow('[!]');
    case 'fail':
      return red('[✗]');
    case 'skip':
      return dim('[—]');
  }
}

function formatSummary(s: DoctorResult['summary']): string {
  const parts = [
    s.ok > 0 ? green(`${s.ok} ok`) : null,
    s.warn > 0 ? yellow(`${s.warn} warn`) : null,
    s.fail > 0 ? red(`${s.fail} fail`) : null,
    s.skip > 0 ? dim(`${s.skip} skip`) : null,
  ].filter(Boolean);
  return `\n${parts.join('  ')}\n`;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export async function checkConfig(configPath?: string): Promise<DoctorRow> {
  try {
    const result = loadConfig(configPath);
    return {
      name: 'Config',
      status: 'ok',
      detail: `loaded ${result.configPath}`,
      extras: [
        `agent: ${getDefaultAgent(result.config).name}`,
        `model: ${getDefaultAgent(result.config).model}`,
        `dataDir: ${result.config.service.dataDir}`,
      ],
    };
  } catch (e) {
    if (e instanceof ConfigLoadError) {
      return {
        name: 'Config',
        status: 'fail',
        detail: `${e.kind}`,
        extras: e.message.split('\n'),
      };
    }
    return { name: 'Config', status: 'fail', detail: (e as Error).message };
  }
}

export async function checkDatabase(dbPath: string): Promise<DoctorRow> {
  if (!existsSync(dbPath)) {
    // Warn (not fail) — the service creates the DB on first boot, and
    // we want a fresh-install operator to be able to run `doctor`
    // before `systemctl start` without seeing a misleading red ✗.
    return {
      name: 'Database',
      status: 'warn',
      detail: `${dbPath} missing — service hasn't booted yet (run \`systemctl start andybioticlaw\`)`,
    };
  }
  try {
    const handle = openDatabase(dbPath, pino({ level: 'silent' }));
    try {
      const journalMode = handle.db.pragma('journal_mode', { simple: true });
      const integrity = handle.db.pragma('integrity_check', { simple: true });
      const codeMigrationCount = countCodeMigrations();
      const dbSchema = handle.db
        .prepare<[], { v: number | null }>(
          'SELECT MAX(version) AS v FROM schema_version',
        )
        .get();
      const dbVersion = dbSchema?.v ?? 0;

      const extras = [
        `journal_mode=${journalMode}`,
        `integrity_check=${integrity}`,
        `schema_version=${dbVersion}/${codeMigrationCount}`,
      ];

      if (journalMode !== 'wal') {
        return {
          name: 'Database',
          status: 'warn',
          detail: `journal_mode is ${journalMode}, expected wal`,
          extras,
        };
      }
      if (integrity !== 'ok') {
        return {
          name: 'Database',
          status: 'fail',
          detail: `integrity_check failed: ${integrity}`,
          extras,
        };
      }
      if (dbVersion !== codeMigrationCount) {
        return {
          name: 'Database',
          status: 'warn',
          detail: `schema ${dbVersion}/${codeMigrationCount} — restart service to migrate`,
          extras,
        };
      }
      return {
        name: 'Database',
        status: 'ok',
        detail: `WAL, integrity ok, schema ${dbVersion}/${codeMigrationCount}`,
        extras,
      };
    } finally {
      handle.close();
    }
  } catch (e) {
    return { name: 'Database', status: 'fail', detail: (e as Error).message };
  }
}

/** Count migration .sql files shipped with the code (the source of truth
 *  for "what schema_version SHOULD be after a clean boot"). */
function countCodeMigrations(): number {
  try {
    const dir = resolve(projectRoot(), 'src', 'db', 'migrations');
    return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
  } catch {
    // Production builds keep the migrations under dist/ — try that too.
    try {
      const dir = resolve(projectRoot(), 'dist', 'db', 'migrations');
      return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
    } catch {
      return 0;
    }
  }
}

export async function checkClaudeAuth(credentialsDir: string): Promise<DoctorRow> {
  const expanded = expandPath(credentialsDir);
  const dirExists = existsSync(expanded);
  if (!dirExists) {
    return {
      name: 'Claude auth',
      status: 'fail',
      detail: `credentialsDir missing: ${expanded}`,
    };
  }
  try {
    const out = await runOnce('claude', ['auth', 'status', '--json'], 5000);
    const parsed = JSON.parse(out.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      apiKeySource?: string;
      subscriptionType?: string | null;
    };
    if (parsed.loggedIn !== true) {
      return {
        name: 'Claude auth',
        status: 'fail',
        detail: 'claude CLI reports not logged in — run `claude login`',
      };
    }
    const isToken = parsed.authMethod === 'oauth_token';
    const method = isToken ? 'token (CLAUDE_CODE_OAUTH_TOKEN)' : 'session (keyring)';
    if (
      parsed.apiKeySource &&
      parsed.apiKeySource !== 'none' &&
      (parsed.apiKeySource === 'ANTHROPIC_API_KEY' ||
        parsed.apiKeySource === 'ANTHROPIC_AUTH_TOKEN')
    ) {
      return {
        name: 'Claude auth',
        status: 'fail',
        detail: `${parsed.apiKeySource} would override subscription auth — unset it`,
      };
    }
    return {
      name: 'Claude auth',
      status: 'ok',
      detail: `subscription, ${method}`,
      extras: [
        `subscriptionType=${parsed.subscriptionType ?? 'null'}`,
        `apiKeySource=${parsed.apiKeySource ?? 'none'}`,
      ],
    };
  } catch (e) {
    return {
      name: 'Claude auth',
      status: 'fail',
      detail: `claude CLI check failed: ${(e as Error).message}`,
    };
  }
}

export async function checkTelegram(allowedUserIds: number[]): Promise<DoctorRow> {
  const tokenRaw = process.env['TELEGRAM_BOT_TOKEN'];
  // Distinguish "not set at all" (warn — bot disabled is a valid
  // operating mode) from "set but empty/whitespace" (fail — almost
  // certainly a typo'd .env line that would silently disable the bot
  // without the operator realising). The wizard never writes empty,
  // but a hand-edited .env can land here.
  if (tokenRaw === undefined) {
    return {
      name: 'Telegram',
      status: 'warn',
      detail: 'TELEGRAM_BOT_TOKEN unset — bot disabled',
    };
  }
  const token = tokenRaw.trim();
  if (token === '') {
    return {
      name: 'Telegram',
      status: 'fail',
      detail: 'TELEGRAM_BOT_TOKEN set but empty — fix .env (likely a stray quotes / blank line)',
    };
  }
  if (allowedUserIds.length === 0) {
    return {
      name: 'Telegram',
      status: 'warn',
      detail: 'telegram.dm.allowedUserIds is empty — no principal',
    };
  }
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/getMe`,
      5000,
    );
    const json = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string; id?: number };
      description?: string;
    };
    if (!res.ok || !json.ok) {
      return {
        name: 'Telegram',
        status: 'fail',
        detail: `getMe failed: ${json.description ?? `HTTP ${res.status}`}`,
      };
    }
    const principalId = allowedUserIds[0];
    return {
      name: 'Telegram',
      status: 'ok',
      detail: `bot @${json.result?.username}, principal id ${principalId}`,
      extras: [`bot id=${json.result?.id}`, `allowedUserIds=${allowedUserIds.join(',')}`],
    };
  } catch (e) {
    return {
      name: 'Telegram',
      status: 'fail',
      detail: `getMe failed: ${(e as Error).message}`,
    };
  }
}

export async function checkDashboard(
  cfg: { enabled: boolean; host: string; port: number; basicAuth: { enabled: boolean; passwordHash: string } },
): Promise<DoctorRow> {
  if (!cfg.enabled) {
    return { name: 'Dashboard', status: 'skip', detail: 'disabled in config' };
  }
  if (cfg.basicAuth.enabled && cfg.basicAuth.passwordHash === '') {
    return {
      name: 'Dashboard',
      status: 'fail',
      detail: 'basicAuth.enabled=true but passwordHash is empty',
    };
  }
  // Try /healthz on the configured host. If it responds 200, the service
  // is running and the dashboard is up. If it errors (ECONNREFUSED) we
  // report that as a warn — dashboard is configured but service isn't
  // currently serving (which is fine if you're running doctor from a
  // shell while the service is stopped).
  const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const url = `http://${host}:${cfg.port}/healthz`;
  try {
    const res = await fetchWithTimeout(url, 2000);
    if (!res.ok) {
      return {
        name: 'Dashboard',
        status: 'warn',
        detail: `${url} → HTTP ${res.status}`,
      };
    }
    return {
      name: 'Dashboard',
      status: 'ok',
      detail: `responding on ${cfg.host}:${cfg.port}`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      return {
        name: 'Dashboard',
        status: 'warn',
        detail: `not currently reachable at ${cfg.host}:${cfg.port} (service stopped?)`,
      };
    }
    return { name: 'Dashboard', status: 'fail', detail: msg };
  }
}

/** Reads pidfile, checks if that pid is alive — independent of dashboard. */
export function checkServiceRunning(dataDir: string): DoctorRow {
  const path = pidFilePath(dataDir);
  if (!existsSync(path)) {
    return {
      name: 'Service',
      status: 'warn',
      detail: 'no pidfile — service is not currently running',
    };
  }
  try {
    const raw = readPidFile(path);
    if (!raw) {
      return { name: 'Service', status: 'warn', detail: 'pidfile is empty' };
    }
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) {
      return {
        name: 'Service',
        status: 'warn',
        detail: `pidfile has bad value: ${raw}`,
      };
    }
    try {
      process.kill(pid, 0);
      return { name: 'Service', status: 'ok', detail: `running, pid ${pid}` };
    } catch {
      return {
        name: 'Service',
        status: 'warn',
        detail: `stale pidfile (pid ${pid} not alive)`,
      };
    }
  } catch (e) {
    return { name: 'Service', status: 'warn', detail: (e as Error).message };
  }
}

function readPidFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

export async function checkSkills(
  skillsDir: string,
  db: Db,
): Promise<DoctorRow> {
  const registry = createSkillRegistry(db);
  const result = loadSkills({
    dir: skillsDir,
    logger: pino({ level: 'silent' }),
    registry,
  });

  const enabled = registry.list().filter((s) => s.enabled);
  const extras: string[] = [];
  let failures = 0;

  for (const skill of enabled) {
    const installSh = resolve(skill.skillDir, 'install.sh');
    const hasInstall = existsSync(installSh);
    const hasMcp = skill.mcpServers.length > 0;
    let mcpProbe: string | null = null;
    if (hasMcp) {
      // Probe each declared MCP server with a stdio JSON-RPC ping
      // (initialize → tools/list). Anything that doesn't respond within
      // 5 s is treated as a failure.
      for (const srv of skill.mcpServers) {
        const ok = await probeMcpServer(srv, skill.skillDir, 5000);
        if (!ok.ok) {
          mcpProbe = `mcp '${srv.name}': ${ok.error}`;
          failures++;
          break;
        }
      }
    }
    const tag = mcpProbe ? '✗' : '✓';
    const note: string[] = [];
    if (!hasInstall) note.push('no install.sh');
    if (!hasMcp) note.push('no mcp');
    if (mcpProbe) note.push(mcpProbe);
    extras.push(`${tag} ${skill.name}@${skill.version}${note.length ? ' — ' + note.join(', ') : ''}`);
  }

  if (result.failed.length > 0) {
    for (const f of result.failed) extras.push(`✗ ${f.name}: ${f.error}`);
    failures += result.failed.length;
  }

  if (failures > 0) {
    return {
      name: 'Skills',
      status: 'fail',
      detail: `${failures} failing of ${enabled.length} enabled`,
      extras,
    };
  }
  return {
    name: 'Skills',
    status: 'ok',
    detail: `${enabled.length} enabled, all reachable`,
    extras,
  };
}

/** Spawn an MCP server, send `initialize` + `tools/list`, return whether
 *  it answered within the timeout. Best-effort — on any error returns
 *  `{ ok: false, error }`. */
async function probeMcpServer(
  srv: { command: string; args: readonly string[] },
  skillDir: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolveProbe) => {
    const args = srv.args.map((a) =>
      a.startsWith('./') ? resolve(skillDir, a) : a,
    );
    const dataDir = expandPath(
      // Best-effort: if the doctor command has access to a config it'll
      // reuse the real DB path; otherwise the spawned server will exit
      // with an error which is exactly the signal we want.
      process.env['ANDYBIOTICLAW_DB_PATH'] ??
        resolve(projectRoot(), 'data', 'andybioticlaw.db'),
    );
    const child = spawn(srv.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ANDYBIOTICLAW_DB_PATH: dataDir,
      },
    });

    let buf = '';
    let stderrBuf = '';
    let settled = false;
    const cleanup = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };
    const finish = (out: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveProbe(out);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `no response in ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
    // If the server exits before answering tools/list, surface the exit
    // code + last stderr line — much more actionable than "no response in 5s"
    // (e.g. google-calendar exits 64 when its OAuth secrets are missing).
    child.on('exit', (code) => {
      clearTimeout(timer);
      const lastErr = stderrBuf.trim().split('\n').pop() ?? '';
      const tail = lastErr ? ` — ${lastErr}` : '';
      finish({
        ok: false,
        error: `exited ${code ?? '?'} before responding${tail}`,
      });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      // Parse line-delimited JSON-RPC. We don't strictly verify the
      // response — getting ANY parsable JSON-RPC response back to one of
      // our requests means the server is alive.
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (obj.id === 2 && (obj.result || obj.error)) {
            clearTimeout(timer);
            finish({ ok: true });
            return;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    // Send initialize, then tools/list. Once the server answers tools/list
    // (id=2) we know it's alive and exposing its tool surface.
    const initMsg =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'doctor', version: '0.1.0' },
        },
      }) + '\n';
    const listMsg =
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n';
    try {
      child.stdin.write(initMsg);
      child.stdin.write(listMsg);
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}

export function checkSchedules(db: Db): DoctorRow {
  try {
    const repo = createSchedulesRepo(db);
    const all = repo.list();
    const enabled = all.filter((s) => s.enabled);
    return {
      name: 'Schedules',
      status: 'ok',
      detail: `${enabled.length} enabled of ${all.length} total`,
      extras: all.map(
        (s) =>
          `${s.enabled ? '✓' : '✗'} ${s.name} (${s.kind})  cron=${s.cron_expr}`,
      ),
    };
  } catch (e) {
    return { name: 'Schedules', status: 'fail', detail: (e as Error).message };
  }
}

export function checkBudget(
  db: Db,
  config: { service: { timezone: string }; budget: { dailyTokenLimit: number; perSessionTokenLimit: number; dailyResetTime: string } },
): DoctorRow {
  try {
    const sessions = createSessionsRepo(db);
    const budgetState = createBudgetStateRepo(db);
    const tracker = createBudgetTracker(
      sessions,
      () => ({
        dailyTokenLimit: config.budget.dailyTokenLimit,
        perSessionTokenLimit: config.budget.perSessionTokenLimit,
        dailyResetTime: config.budget.dailyResetTime,
        timezone: config.service.timezone,
      }),
      budgetState,
    );
    const status = tracker.status();
    const pct = status.dailyLimit
      ? Math.round((status.used / status.dailyLimit) * 100)
      : 0;
    if (status.exhausted) {
      return {
        name: 'Budget',
        status: 'warn',
        detail: `exhausted: ${status.used}/${status.dailyLimit} tokens used`,
      };
    }
    return {
      name: 'Budget',
      status: 'ok',
      detail: `${status.used}/${status.dailyLimit} tokens used (${pct}%)`,
      extras: [
        `remaining=${status.remaining}`,
        `perSessionLimit=${status.perSessionLimit}`,
      ],
    };
  } catch (e) {
    return { name: 'Budget', status: 'fail', detail: (e as Error).message };
  }
}

export function checkDisk(dbPath: string): DoctorRow {
  try {
    const dbStat = statSync(dbPath);
    const dbSizeMb = (dbStat.size / (1024 * 1024)).toFixed(2);
    const free = freeSpaceMb(dbPath);
    if (free !== null && free < 1024) {
      return {
        name: 'Disk',
        status: 'warn',
        detail: `db ${dbSizeMb} MiB, free ${free.toFixed(0)} MiB (under 1 GiB)`,
      };
    }
    const freeStr = free === null ? 'unknown' : `${(free / 1024).toFixed(2)} GiB free`;
    return {
      name: 'Disk',
      status: 'ok',
      detail: `db ${dbSizeMb} MiB, ${freeStr}`,
    };
  } catch (e) {
    return { name: 'Disk', status: 'fail', detail: (e as Error).message };
  }
}

/** Runs `df -k <path>` and parses the "Available" column. Returns MiB,
 *  or null if df is unavailable / output unrecognised. */
function freeSpaceMb(path: string): number | null {
  try {
    const out = execSync(`df -k ${escapeArg(path)}`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return null;
    // df output: header line + one data line. Available is column index 3
    // on macOS / Linux POSIX df output (1024-block units).
    const cols = lines[lines.length - 1]!.trim().split(/\s+/);
    const availKb = Number(cols[3]);
    if (!Number.isFinite(availKb)) return null;
    return availKb / 1024; // KiB → MiB
  } catch {
    return null;
  }
}

function escapeArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function checkLogs(logsDirPath: string): DoctorRow {
  if (!existsSync(logsDirPath)) {
    return {
      name: 'Logs',
      status: 'warn',
      detail: `${logsDirPath} missing — created on first service boot`,
    };
  }
  try {
    accessSync(logsDirPath, constants.W_OK);
  } catch {
    return {
      name: 'Logs',
      status: 'fail',
      detail: `${logsDirPath} not writable`,
    };
  }
  const logPath = resolve(logsDirPath, 'andybioticlaw.log');
  if (!existsSync(logPath)) {
    return {
      name: 'Logs',
      status: 'warn',
      detail: `andybioticlaw.log missing (service may not have run yet)`,
    };
  }
  try {
    const stat = statSync(logPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    const extras = [
      `size=${sizeMb} MiB`,
      `last write ${ageHours.toFixed(1)}h ago`,
    ];
    if (stat.size > 100 * 1024 * 1024) {
      return {
        name: 'Logs',
        status: 'warn',
        detail: `${sizeMb} MiB — consider rotation`,
        extras,
      };
    }
    return {
      name: 'Logs',
      status: 'ok',
      detail: `writable, ${sizeMb} MiB, last write ${ageHours.toFixed(1)}h ago`,
      extras,
    };
  } catch (e) {
    return { name: 'Logs', status: 'fail', detail: (e as Error).message };
  }
}

/**
 * Reports the configured agents from the `agents:` block. Validates
 * that exactly one agent has `default: true` and that ids are unique
 * — the schema's refines should already guarantee this, but doctor
 * checks again because a hand-edited config could fall out of spec
 * between reloads.
 */
export function checkAgents(config: {
  agents: ReadonlyArray<{ id: string; name: string; default: boolean }>;
}): DoctorRow {
  // Schema's nonempty + refines guarantee at least one entry, exactly
  // one default, unique ids. Doctor still validates because a hand-
  // edited config.yaml could violate before the next reload picks it up.
  const agents = config.agents;
  if (agents.length === 0) {
    return {
      name: 'Agents',
      status: 'fail',
      detail: 'agents: block is empty',
    };
  }
  const defaults = agents.filter((a) => a.default);
  if (defaults.length !== 1) {
    return {
      name: 'Agents',
      status: 'fail',
      detail:
        defaults.length === 0
          ? `${agents.length} agent(s) but none marked default: true`
          : `${defaults.length} agents marked default — exactly one must be`,
      extras: defaults.map((a) => `default: ${a.id} (${a.name})`),
    };
  }
  const ids = new Set<string>();
  for (const a of agents) {
    if (ids.has(a.id)) {
      return {
        name: 'Agents',
        status: 'fail',
        detail: `duplicate agent id: ${a.id}`,
      };
    }
    ids.add(a.id);
  }
  return {
    name: 'Agents',
    status: 'ok',
    detail: `${agents.length} agent(s), default=${defaults[0]!.id}`,
    extras: agents.map(
      (a) => `${a.default ? '*' : ' '} ${a.id} (${a.name})`,
    ),
  };
}

/**
 * Reports the policies file's presence + that the principal context
 * resolves cleanly. `null` principalUserId is a warn (operator hasn't
 * set telegram.dm.allowedUserIds yet); missing file is a warn (will
 * auto-generate on first boot); a parse error is a fail.
 */
export function checkPolicies(
  filePath: string,
  principalUserId: number | null,
): DoctorRow {
  let file: ReturnType<typeof loadPolicies>;
  try {
    file = loadPolicies(filePath);
  } catch (e) {
    return {
      name: 'Policies',
      status: 'fail',
      detail: (e as Error).message,
    };
  }
  if (!file) {
    return {
      name: 'Policies',
      status: 'warn',
      detail: `${filePath} missing — will auto-generate on next service boot`,
    };
  }
  if (principalUserId === null) {
    return {
      name: 'Policies',
      status: 'warn',
      detail: `${Object.keys(file.contexts).length} context(s); no principal id configured`,
    };
  }
  // Resolve the principal context as a smoke test of the file's shape.
  const principalKey = makeContextKey({
    agentId: 'emma',
    channel: 'telegram',
    chatId: principalUserId,
  });
  let resolved;
  try {
    resolved = resolvePolicy(file, principalKey);
  } catch (e) {
    return {
      name: 'Policies',
      status: 'fail',
      detail: `principal context resolves with error: ${(e as Error).message}`,
    };
  }
  return {
    name: 'Policies',
    status: 'ok',
    detail: `${Object.keys(file.contexts).length} context(s); principal execMode=${resolved.execMode}`,
    extras: [
      `principal context: ${principalKey}`,
      `scheduleKinds: ${resolved.scheduleKinds.join(', ')}`,
      `scheduleAgentTaskCap: ${resolved.scheduleAgentTaskCap}`,
      `skillsVisible: ${resolved.skillsVisible.join(', ')}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runOnce(cmd: string, args: readonly string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolveCmd, rejectCmd) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectCmd(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectCmd(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCmd({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// `cyan` import retained for future use; satisfies lint by being referenced.
void cyan;
