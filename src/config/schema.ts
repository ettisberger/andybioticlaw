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
  'agents.0.haikuModel',
  'agents.0.routing.enabled',
  'agents.0.routing.minCharsForOpus',
  'observability.heartbeatIntervalSec',
  'observability.heartbeatRetentionDays',
  'observability.errorsToTelegram',
  'observability.errorChatIdOverride',
];

/**
 * Dotted paths that require a full service restart. Listed for documentation
 * and for the reload diff to reason about "unknown changed field" cases.
 */
export const RESTART_REQUIRED_PATHS: ReadonlyArray<string> = [
  'service.name',
  'service.dataDir',
  'service.timezone',
  'agents.0.name',
  'agents.0.model',
  'agents.0.credentialsDir',
  'agents.0.streamIdleTimeoutSec',
  'telegram.dm.allowedUserIds',
  'telegram.dm.runMode',
  'telegram.group.allowedGroupIds',
  'telegram.group.runMode',
  'telegram.group.workspaceBase',
  'dashboard.enabled',
  'dashboard.host',
  'dashboard.port',
  'dashboard.basicAuth.enabled',
  'dashboard.basicAuth.username',
  'dashboard.basicAuth.passwordHash',
  'skills.dir',
  'skills.autoLoadOnStart',
];
