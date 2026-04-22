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

export const AgentConfig = z.object({
  name: z.string().min(1),
  model: z.string().regex(ModelIdRegex, {
    message:
      'model must be a valid Claude model ID like "claude-opus-4-7", "claude-sonnet-4-6", or "claude-haiku-4-5-20251001"',
  }),
  credentialsDir: z.string().min(1),
  streamIdleTimeoutSec: z.number().int().positive(),
  allowedTools: z.union([z.literal('all'), z.string().min(1)]),
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

export const TelegramConfig = z.object({
  dm: TelegramDmConfig,
  group: TelegramGroupConfig,
  streamEditIntervalMs: z.number().int().min(200).max(10_000),
  longTaskNotifyAfterMs: z.number().int().min(1_000),
  conversationHistoryLimit: z.number().int().min(0).max(500),
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

export const Config = z.object({
  service: ServiceConfig,
  agent: AgentConfig,
  telegram: TelegramConfig,
  budget: BudgetConfig,
  memory: MemoryConfig,
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
  'telegram.streamEditIntervalMs',
  'telegram.longTaskNotifyAfterMs',
  'telegram.conversationHistoryLimit',
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
  'agent.name',
  'agent.model',
  'agent.credentialsDir',
  'agent.streamIdleTimeoutSec',
  'agent.allowedTools',
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
