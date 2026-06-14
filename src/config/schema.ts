import { z } from 'zod';

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const ServiceConfig = z.object({
  name: z.string().min(1),
  dataDir: z.string().min(1),
  logLevel: LogLevel,
  timezone: z.string().min(1),
});

const ModelIdRegex = /^claude-[a-z]+(?:-\d+)+(?:-\d{8})?$/;

/**
 * Opt-in cheap-model router. When `routing.enabled`, the DM handler
 * sends short/simple queries to `haikuModel` (default Haiku) instead
 * of the primary `model` (default Opus). Heuristic-based — see
 * `src/agent/route.ts`. Scheduled agent-tasks are NOT routed.
 */
export const AgentRoutingConfig = z.object({
  enabled: z.boolean().default(false),
  minCharsForOpus: z.number().int().min(0).max(10_000).default(120),
});

export const TelegramDmConfig = z.object({
  allowedUserIds: z.array(z.number().int().positive()).default([]),
  runMode: z.literal('host'),
});

export const TelegramGroupConfig = z.object({
  allowedGroupIds: z.array(z.number().int()).default([]),
  runMode: z.literal('workspace'),
  workspaceBase: z.string().min(1),
});

/**
 * Voice-input pre-processing for Telegram DMs. The on/off toggle itself
 * lives in SQLite (`voice_state.enabled`) so it can be flipped from the
 * CLI menu without a service restart. These knobs are the parts that
 * *rarely* change — they fit better as static config.
 */
export const TelegramVoiceConfig = z.object({
  /** Reject voice messages longer than this (Telegram → Groq upload cap). */
  maxDurationSec: z.number().int().min(5).max(600).default(120),
  /** 'auto' lets Groq detect; otherwise ISO-639-1 code passed verbatim. */
  language: z.string().default('auto'),
});

export const TelegramConfig = z.object({
  dm: TelegramDmConfig,
  group: TelegramGroupConfig,
  streamEditIntervalMs: z.number().int().min(200).max(10_000),
  longTaskNotifyAfterMs: z.number().int().min(1_000),
  conversationHistoryLimit: z.number().int().min(0).max(500),
  voice: TelegramVoiceConfig.default({ maxDurationSec: 120, language: 'auto' }),
  /**
   * Boot-time status notification. When `enabled`, the service sends a
   * one-line "🤖 <agent> online" message to the principal chat after
   * every successful systemd start. Useful as a deploy-completion ping.
   * Default: off (a service that restarts often during dev would spam
   * the chat). Read once at boot — both fields are restart-required.
   */
  statusMessage: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * Which agent's name appears in the bold header. Defaults to the
       * agent with `default: true`. Only matters in multi-agent setups
       * where the operator wants the boot notice branded as a specific
       * persona (e.g. work-Emma's restart pings the work group).
       */
      agentId: z.string().optional(),
    })
    .default({ enabled: false }),
});

export const BudgetConfig = z.object({
  dailyTokenLimit: z.number().int().nonnegative(),
  perSessionTokenLimit: z.number().int().nonnegative(),
  perScheduleDefault: z.number().int().nonnegative(),
  dailyResetTime: z.string().regex(/^\d{2}:\d{2}$/, 'dailyResetTime must be "HH:MM"'),
});

export const MemoryConfig = z.object({
  autoAccept: z.boolean(),
  defaultScopes: z.array(z.string().min(1)),
  ttlCleanupCron: z.string().min(1),
});

export const MessagesConfig = z.object({
  /**
   * If set, the nightly TTL cron deletes messages older than this many
   * days. Sessions themselves are retained — only the conversation
   * bodies are pruned. `null` (default) means keep forever.
   */
  retentionDays: z.number().int().positive().nullable().default(null),
});

export const DashboardBasicAuthConfig = z.object({
  enabled: z.boolean(),
  username: z.string().default('admin'),
  passwordHash: z.string().default(''),
});

export const DashboardConfig = z.object({
  enabled: z.boolean(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  basicAuth: DashboardBasicAuthConfig,
});

export const ObservabilityConfig = z.object({
  heartbeatIntervalSec: z.number().int().min(5).max(3600),
  heartbeatRetentionDays: z.number().int().min(1).max(365),
  errorsToTelegram: z.boolean(),
  errorChatIdOverride: z.number().int().nullable(),
});

export const SkillsConfig = z.object({
  dir: z.string().min(1),
  autoLoadOnStart: z.boolean(),
});

/**
 * Read-only "Projects" page in the dashboard. Off by default so existing
 * installs see no change. Operators who keep a folder of git repos
 * (`~/projects`, `~/code`, `~/Developer`, `/srv/projects`, …) can flip
 * `enabled: true` and point `folderPath` at it for a workspace overview.
 *
 * The page surfaces git metadata + a couple of project-type marker flags
 * (Dockerfile / package.json / etc.) — no deploy logic, no proxy parsing,
 * no container introspection. Pure read-only filesystem + git info.
 */
export const ProjectsConfig = z.object({
  enabled: z.boolean().default(false),
  /** Folder containing one subdir per project. `~` is expanded; symlinks
   *  are followed via realpath() before scanning. */
  folderPath: z.string().min(1).default('~/projects'),
  /** Repos with no commits in this many days are flagged "stale". */
  staleDays: z.number().int().min(1).max(3650).default(90),
}).default({ enabled: false, folderPath: '~/projects', staleDays: 90 });

/**
 * Browser-automation skill config. The `browser` skill (skills/browser/)
 * wraps Playwright + Chromium and exposes a snapshot/ref toolset to
 * Emma. Per-profile user-data-dirs persist logged-in identities across
 * service restarts; a hostname allowlist enforces SSRF-style guardrails
 * on every request.
 *
 * Off by default — opt-in like the projects feature. Reading this block
 * happens in two places: (1) the dashboard (when Phase 3 lands) and
 * (2) the per-session MCP server itself, which re-reads on file change
 * to pick up allowlist edits without a restart.
 */
export const BrowserProfile = z.object({
  /** Profile name — used as a folder name under data/browser/profiles/ and
   *  shown to the agent in SKILL.md, so safe filesystem chars only. */
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'profile name must be kebab-case, starting with a letter'),
  /** One-line summary the agent sees in SKILL.md, e.g. "ProtonMail account". */
  description: z.string().max(200).optional(),
});
export type BrowserProfile = z.infer<typeof BrowserProfile>;

export const BrowserDashboardConfig = z.object({
  enabled: z.boolean().default(true),
  /** Delete browser_events rows older than this many days. */
  retentionDays: z.number().int().min(1).max(365).default(7),
  /** Delete oldest screenshot files (LRU by created_at) until total dir
   *  size is under this many MB. */
  retentionMb: z.number().int().min(10).max(10_000).default(50),
  /** Capture a screenshot on every `browser_snapshot` call too (off by
   *  default — snapshots fire often during a normal session and would
   *  dominate disk usage). Click/type/navigate are always captured. */
  screenshotOnSnapshot: z.boolean().default(false),
}).default({ enabled: true, retentionDays: 7, retentionMb: 50, screenshotOnSnapshot: false });

export const BrowserConfig = z.object({
  enabled: z.boolean().default(false),
  /** Patterns: bare host ("proton.me"), wildcard ("*.proton.me", any
   *  subdomain ≥1 label), or "*" (allow all — operator escape hatch).
   *  Empty array = block everything. Hostnames are canonicalized to
   *  punycode before comparison so IDN homoglyphs don't bypass. */
  hostnameAllowlist: z.array(z.string().min(1)).default([]),
  profiles: z.array(BrowserProfile).default([]),
  /** Optional default profile. Today the agent always passes `profile`
   *  on each call; future enhancement may use this. */
  defaultProfile: z.string().optional(),
  dashboard: BrowserDashboardConfig,
}).default({ enabled: false, hostnameAllowlist: [], profiles: [], dashboard: { enabled: true, retentionDays: 7, retentionMb: 50, screenshotOnSnapshot: false } });

/**
 * One-line ASCII slug. Used as the stable id for both agents and policy
 * contexts so the same string can appear in URLs, log lines, and DB
 * columns without quoting or escaping.
 */
const SlugId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be lowercase alphanumeric/hyphen, 1-32 chars, starting with a letter');

/**
 * Per-agent definition. Each agent gets its own model, system prompt,
 * skill visibility, and Telegram bot token. The default install ships
 * with one agent ('emma'); additional agents are added by appending
 * entries here + a binding rule + a policy block in policies.json.
 *
 * Mirrors the OpenClaw `agents.list` shape (see docs/ARCHITECTURE.md).
 */
export const AgentConfigEntry = z.object({
  id: SlugId,
  /** Human-readable display name. Substituted into `system.base.md`. */
  name: z.string().min(1).max(64),
  /** Exactly one agent in the list must have `default: true` — the
   *  resolver falls back to it for any binding-miss. */
  default: z.boolean().default(false),
  /** Primary model id. Same regex as the legacy `agent.model`. */
  model: z.string().regex(ModelIdRegex, 'invalid agent.model'),
  /** Cheap fallback model used by the router when routing.enabled. */
  haikuModel: z.string().regex(ModelIdRegex, 'invalid agent.haikuModel').default('claude-haiku-4-5-20251001'),
  /** Where Claude credentials live. Usually shared across agents. */
  credentialsDir: z.string().min(1),
  /** Per-session timeout — same as legacy `agent.streamIdleTimeoutSec`. */
  streamIdleTimeoutSec: z.number().int().positive().default(300),
  /** Cron-router toggle. */
  routing: AgentRoutingConfig.default({ enabled: false, minCharsForOpus: 120 }),
  /** Skills visible to this agent. `["*"]` means all enabled skills.
   *  Required at agent creation — forces explicit thought about scope
   *  when adding a second agent. */
  skills: z.array(z.union([z.literal('*'), SlugId])).nonempty(),
  /** Env-var name holding this agent's Telegram bot token. Optional —
   *  defaults to `TELEGRAM_BOT_TOKEN` when only one agent exists. */
  tokenEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  /** Override for the system prompt path. Defaults to the bundled
   *  `system.base.md`. Useful when each agent needs a distinct persona. */
  systemPromptFile: z.string().min(1).optional(),
  /** Per-agent workspace dir. When unset, all agents share the legacy
   *  `data/workspaces/`. When multiple agents exist, each should have
   *  its own directory to keep skill state from leaking across agents. */
  workspace: z.string().min(1).optional(),
});
export type AgentConfigEntry = z.infer<typeof AgentConfigEntry>;

/**
 * Routing rule mapping incoming messages → agentId. Deterministic
 * precedence: rules higher up the array win, with the default agent
 * (per `agents[].default: true`) used when no rule matches. Mirrors
 * OpenClaw's `bindings`.
 */
export const BindingRule = z.object({
  agentId: SlugId,
  /** What kind of incoming source this rule matches. */
  match: z.object({
    /** Channel — currently only telegram. Designed extensible. */
    channel: z.enum(['telegram']),
    /** When set: rule fires only for these telegram chat ids
     *  (DMs use the user id; groups use the negative chat id). */
    chatIds: z.array(z.number().int()).optional(),
    /** When set: rule fires only for these telegram user ids. */
    userIds: z.array(z.number().int().positive()).optional(),
  }),
});
export type BindingRule = z.infer<typeof BindingRule>;

export const Config = z.object({
  service: ServiceConfig,
  /**
   * Multi-agent definitions. Required: at least one entry, exactly
   * one with `default: true`. Adding a second agent is a config edit
   * + restart — see docs/ARCHITECTURE.md "Adding a second agent".
   */
  agents: z
    .array(AgentConfigEntry)
    .nonempty()
    .refine(
      (arr) => arr.filter((a) => a.default).length === 1,
      'exactly one agent must have default: true',
    )
    .refine(
      (arr) => new Set(arr.map((a) => a.id)).size === arr.length,
      'agent ids must be unique',
    ),
  /**
   * Routing rules. May be empty — the resolver falls back to the
   * default agent when no rule matches. Required for clarity:
   * operators with multiple agents must spell out which channel maps
   * to which agent.
   */
  bindings: z.array(BindingRule).default([]),
  telegram: TelegramConfig,
  budget: BudgetConfig,
  memory: MemoryConfig,
  messages: MessagesConfig.default({ retentionDays: null }),
  dashboard: DashboardConfig,
  observability: ObservabilityConfig,
  skills: SkillsConfig,
  projects: ProjectsConfig,
  browser: BrowserConfig,
});

export type Config = z.infer<typeof Config>;

/**
 * Dotted paths (relative to the root Config) that are hot-reloadable — a SIGHUP
 * will pick up changes to these fields without requiring a full service restart.
 *
 * The set is intentionally explicit. Everything else is restart-required.
 */
export const HOT_RELOADABLE_PATHS: ReadonlyArray<string> = [
  'service.logLevel',
  'budget.dailyTokenLimit',
  'budget.perSessionTokenLimit',
  'budget.perScheduleDefault',
  'budget.dailyResetTime',
  'memory.autoAccept',
  'memory.defaultScopes',
  'memory.ttlCleanupCron',
  'messages.retentionDays',
  'telegram.streamEditIntervalMs',
  'telegram.longTaskNotifyAfterMs',
  'telegram.conversationHistoryLimit',
  'observability.heartbeatIntervalSec',
  'observability.heartbeatRetentionDays',
  'observability.errorsToTelegram',
  'observability.errorChatIdOverride',
  // Projects page reads its config on every dashboard fetch — flipping
  // `enabled` or moving `folderPath` takes effect on the next poll, no
  // restart needed.
  'projects.enabled',
  'projects.folderPath',
  'projects.staleDays',
  // Browser allowlist + retention/screenshot toggles are hot-reloadable.
  // The MCP server fs.watches the config file and re-reads these. Profile
  // list / enabled toggle are RESTART_REQUIRED below — they change MCP
  // server spawn or the SKILL.md content templated at session-assembly.
  'browser.hostnameAllowlist',
  'browser.dashboard.enabled',
  'browser.dashboard.retentionDays',
  'browser.dashboard.retentionMb',
  'browser.dashboard.screenshotOnSnapshot',
];

/**
 * Dotted paths that require a full service restart. Listed for documentation
 * and for the reload diff to reason about "unknown changed field" cases.
 */
export const RESTART_REQUIRED_PATHS: ReadonlyArray<string> = [
  'service.name',
  'service.dataDir',
  'service.timezone',
  'telegram.dm.allowedUserIds',
  'telegram.dm.runMode',
  'telegram.group.allowedGroupIds',
  'telegram.group.runMode',
  'telegram.group.workspaceBase',
  'telegram.statusMessage.enabled',
  'telegram.statusMessage.agentId',
  'dashboard.enabled',
  'dashboard.host',
  'dashboard.port',
  'dashboard.basicAuth.enabled',
  'dashboard.basicAuth.username',
  'dashboard.basicAuth.passwordHash',
  'skills.dir',
  'skills.autoLoadOnStart',
  // Toggling browser on/off changes which MCP servers spawn; profile list
  // changes the {{profiles}} substitution in SKILL.md so a restart is
  // needed for the agent to see the new list.
  'browser.enabled',
  'browser.profiles',
  'browser.defaultProfile',
];

/**
 * Per-agent fields that are hot-reloadable for ANY agent index. Used by
 * `isHotReloadable()` below to classify `agents.<i>.<field>` paths
 * without enumerating every agent statically — adding a second agent
 * doesn't require a schema.ts edit.
 */
const HOT_RELOADABLE_AGENT_FIELDS = new Set<string>([
  'haikuModel',
  'routing.enabled',
  'routing.minCharsForOpus',
]);

/**
 * Per-agent fields that require a restart for ANY agent index. Notable
 * inclusion: `skills` — skills are loaded at boot from disk into a
 * registry, so changing the agent's `skills` filter requires a restart
 * to take effect.
 */
const RESTART_REQUIRED_AGENT_FIELDS = new Set<string>([
  'name',
  'model',
  'credentialsDir',
  'streamIdleTimeoutSec',
  'skills',
  'systemPromptFile',
  'tokenEnvVar',
]);

/**
 * True iff the dotted path identifies a field whose change should
 * apply live (no restart). Handles the literal `HOT_RELOADABLE_PATHS`
 * list AND the dynamic `agents.<i>.<field>` pattern for any agent
 * index.
 */
export function isHotReloadable(path: string): boolean {
  if (HOT_RELOADABLE_PATHS.includes(path)) return true;
  const m = path.match(/^agents\.\d+\.(.+)$/);
  if (!m) return false;
  return HOT_RELOADABLE_AGENT_FIELDS.has(m[1]!);
}

/**
 * True iff the dotted path identifies a field whose change requires
 * a full service restart. Handles the literal
 * `RESTART_REQUIRED_PATHS` list AND the `agents.<i>.<field>` pattern.
 */
export function isRestartRequired(path: string): boolean {
  if (RESTART_REQUIRED_PATHS.includes(path)) return true;
  const m = path.match(/^agents\.\d+\.(.+)$/);
  if (!m) return false;
  return RESTART_REQUIRED_AGENT_FIELDS.has(m[1]!);
}
