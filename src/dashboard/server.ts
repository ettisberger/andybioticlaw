import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyBasicAuth from '@fastify/basic-auth';
import argon2 from 'argon2';
import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import type { SessionsRepo } from '../db/repositories/sessions.js';
import type { MessagesRepo } from '../db/repositories/messages.js';
import type { MemoryManager } from '../memory/manager.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { SchedulesRepo } from '../db/repositories/schedules.js';
import type { HeartbeatsRepo } from '../db/repositories/heartbeats.js';
import type { AuditRepo } from '../db/repositories/audit.js';
import type { BudgetTracker } from '../agent/budget.js';
import type { QueueManager } from '../agent/queue.js';
import type {
  SessionExecuteInput,
  SessionExecuteResult,
} from '../agent/session.js';
import type { Config } from '../config/schema.js';
import type { DispatchDeps } from '../agent/dispatch.js';
import type { RateLimitTracker } from '../agent/rate-limit-tracker.js';
import { overviewRoutes } from './routes/overview.js';
import { sessionsRoutes } from './routes/sessions.js';
import { schedulesRoutes } from './routes/schedules.js';
import { memoryRoutes } from './routes/memory.js';
import { skillsRoutes } from './routes/skills.js';
import { configRoutes } from './routes/config.js';
import { auditRoutes } from './routes/audit.js';
import { logsRoutes } from './routes/logs.js';
import { createLogBroadcaster } from './log-broadcaster.js';

export interface DashboardDeps {
  currentConfig: () => Config;
  logger: Logger;
  sessions: SessionsRepo;
  messages: MessagesRepo;
  memoryManager: MemoryManager;
  skills: SkillRegistry;
  schedules: SchedulesRepo;
  heartbeats: HeartbeatsRepo;
  audit: AuditRepo;
  budget: BudgetTracker;
  queue: QueueManager<SessionExecuteInput, SessionExecuteResult> | null;
  dispatch: DispatchDeps | null;
  principalUserId: number | null;
  agentName: string;
  model: string;
  timezone: string;
  credentialsOk: () => boolean;
  logPath: string;
  /** Absolute path to the built frontend's dist dir (served as static). */
  frontendDistDir: string;
  /** Called when the scheduler should re-read DB state (after API mutations). */
  onSchedulesChanged: () => void;
  rateLimitTracker: RateLimitTracker;
}

export interface DashboardService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDashboard(deps: DashboardDeps): DashboardService {
  const cfg = deps.currentConfig();
  const app: FastifyInstance = Fastify({
    logger: false, // we use pino ourselves; avoid double-logging
    trustProxy: false,
  });

  // Basic auth (optional).
  const basicAuthCfg = cfg.dashboard.basicAuth;
  if (basicAuthCfg.enabled) {
    if (!basicAuthCfg.passwordHash) {
      deps.logger.error(
        'dashboard.basicAuth.enabled=true but passwordHash is empty — refusing to start dashboard',
      );
      throw new Error('dashboard basic auth misconfigured');
    }
    app.register(fastifyBasicAuth, {
      validate: async (username: string, password: string) => {
        if (username !== basicAuthCfg.username) {
          throw new Error('invalid credentials');
        }
        const ok = await argon2.verify(basicAuthCfg.passwordHash, password);
        if (!ok) throw new Error('invalid credentials');
      },
      authenticate: { realm: 'andybioticlaw' },
    });
    app.after(() => {
      app.addHook('onRequest', app.basicAuth);
    });
  }

  app.register(fastifyWebsocket);

  // API routes.
  app.register(
    overviewRoutes({
      sessions: deps.sessions,
      heartbeats: deps.heartbeats,
      budget: deps.budget,
      skills: deps.skills,
      schedules: deps.schedules,
      queue: deps.queue,
      credentialsOk: deps.credentialsOk,
      agentName: deps.agentName,
      model: deps.model,
      timezone: deps.timezone,
      rateLimitTracker: deps.rateLimitTracker,
    }),
  );

  app.register(
    sessionsRoutes({
      sessions: deps.sessions,
      messages: deps.messages,
      dispatch: deps.dispatch,
      principalUserId: deps.principalUserId,
    }),
  );

  app.register(
    schedulesRoutes({
      schedules: deps.schedules,
      onMutate: deps.onSchedulesChanged,
    }),
  );

  app.register(
    memoryRoutes({
      manager: deps.memoryManager,
      principalUserId: deps.principalUserId,
    }),
  );

  app.register(skillsRoutes({ skills: deps.skills }));

  app.register(configRoutes({ currentConfig: deps.currentConfig }));

  app.register(auditRoutes({ audit: deps.audit }));

  const broadcaster = createLogBroadcaster(deps.logPath, deps.logger);
  app.register(logsRoutes({ broadcaster }));

  // Static frontend (Vite build output). If the dir doesn't exist yet, the
  // `/` route returns a placeholder so the dashboard is still testable in
  // dev before the frontend is built.
  if (existsSync(deps.frontendDistDir)) {
    // `wildcard: true` (fastify-static default) resolves the requested path
    // against the filesystem at REQUEST time. We previously used `false`
    // which froze the file list at plugin-registration time — rebuilding
    // the frontend (new hashed bundle name) then returned the SPA fallback
    // for the new JS file and produced a black screen until restart.
    // `decorateReply: true` stays enabled for `reply.sendFile()`.
    app.register(fastifyStatic, {
      root: deps.frontendDistDir,
      prefix: '/',
      wildcard: true,
    });
    // SPA fallback — any non-API 404 serves index.html so deep links work.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      ok: true,
      note: `frontend not built yet — run \`pnpm --filter @andybioticlaw/web build\` to generate ${deps.frontendDistDir}`,
    }));
  }

  const host = cfg.dashboard.host;
  const port = cfg.dashboard.port;

  return {
    async start() {
      if (!cfg.dashboard.enabled) {
        deps.logger.info('dashboard disabled in config — skipping');
        return;
      }
      broadcaster.start();
      await app.listen({ host, port });
      deps.logger.info({ host, port }, 'dashboard listening');
    },
    async stop() {
      broadcaster.stop();
      try {
        await app.close();
      } catch (e) {
        deps.logger.warn({ err: (e as Error).message }, 'dashboard close failed');
      }
    },
  };
}

export async function hashDashboardPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}
