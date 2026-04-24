import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyBasicAuth from '@fastify/basic-auth';
import argon2 from 'argon2';
import { existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import type { LiveSessionsTracker } from '../observability/live-sessions.js';
import { overviewRoutes } from './routes/overview.js';
import { sessionsRoutes } from './routes/sessions.js';
import { schedulesRoutes } from './routes/schedules.js';
import { memoryRoutes } from './routes/memory.js';
import { skillsRoutes } from './routes/skills.js';
import { configRoutes } from './routes/config.js';
import { auditRoutes } from './routes/audit.js';
import { logsRoutes } from './routes/logs.js';
import { agentRoutes } from './routes/agent.js';
import { statsRoutes } from './routes/stats.js';
import { createLogBroadcaster } from './log-broadcaster.js';
import type { BotProfile } from '../telegram/bot.js';
import type { AuthMethod } from '../agent/credentials.js';

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
  /** Which subscription-bound auth path is active: keyring session, long-lived
   *  CLAUDE_CODE_OAUTH_TOKEN, or unknown. `null` when `credentialsOk` is false. */
  authMethod: () => AuthMethod | null;
  logPath: string;
  /** Absolute path to the built frontend's dist dir (served as static). */
  frontendDistDir: string;
  /** Called when the scheduler should re-read DB state (after API mutations). */
  onSchedulesChanged: () => void;
  rateLimitTracker: RateLimitTracker;
  liveSessions: LiveSessionsTracker;
  /** Returns the cached Telegram bot profile (username, avatar bytes), or
   *  `null` if the bot isn't running / the profile hasn't been fetched yet.
   *  Populated at telegram.start() + on-demand. */
  botProfile: () => BotProfile | null;
  /**
   * Returns true iff a trivial DB round-trip succeeds. Used by /healthz.
   * Kept as a callback rather than a repo method so the implementation can
   * catch write-lock / corrupt-schema errors uniformly.
   */
  dbPing: () => boolean;
  /** Returns true once SIGTERM/SIGINT has been received; /healthz flips to 503. */
  isShuttingDown: () => boolean;
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

  // /healthz — trivial liveness + DB ping, always reachable (no basic-auth
  // and no CSRF check). Registered BEFORE both hooks below so monitoring
  // tools can poll without credentials or tokens.
  app.get('/healthz', async (_req, reply) => {
    if (deps.isShuttingDown()) {
      reply.code(503);
      return { ok: false, reason: 'shutting_down' };
    }
    if (!deps.dbPing()) {
      reply.code(503);
      return { ok: false, reason: 'db_unreachable' };
    }
    return { ok: true };
  });

  // --- CSRF (double-submit cookie) ---------------------------------------
  // On any request without one, the `_abl_csrf` cookie is set to 32 random
  // bytes hex. Mutating requests (POST/PUT/PATCH/DELETE, but NOT /healthz)
  // must echo that value back as `X-CSRF-Token`. Cookie is SameSite=Strict
  // + Path=/ + no HttpOnly (so same-origin JS can read it); cross-origin
  // JS cannot read it (cookies don't leak across origins), so a malicious
  // cross-origin page can't forge the matching header.
  //
  // Skipped for /healthz to keep the liveness probe credentials-free.
  // Skipped for /api/logs/stream WebSocket upgrade because the initial
  // GET has to start the ws handshake; CSRF-relevant state-changes over
  // that socket are non-existent (it's append-only log broadcast).
  const CSRF_COOKIE = '_abl_csrf';
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const EXEMPT_PATHS = new Set(['/healthz']);

  function parseCookies(header: string | undefined): Record<string, string> {
    if (!header) return {};
    const out: Record<string, string> = {};
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function ensureCsrfCookie(req: FastifyRequest, reply: FastifyReply): string {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[CSRF_COOKIE];
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) {
      token = randomBytes(32).toString('hex');
      // Not HttpOnly — by design, same-origin JS must read it to echo
      // back via header. SameSite=Strict is the real protection.
      reply.header(
        'set-cookie',
        `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`,
      );
    }
    return token;
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (EXEMPT_PATHS.has(path)) return;
    // Always (re)issue the cookie on GET/HEAD so browsers pick it up before
    // their first mutating request. ensureCsrfCookie is idempotent.
    ensureCsrfCookie(req, reply);
    if (!MUTATING.has(req.method)) return;
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = req.headers['x-csrf-token'];
    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      cookieToken.length !== headerToken.length ||
      !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
    ) {
      reply.code(403);
      return reply.send({ error: 'csrf token missing or mismatched' });
    }
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
      // Wrap app.basicAuth so /healthz stays open — monitoring tooling
      // shouldn't need to carry the dashboard password.
      app.addHook('onRequest', (req, reply, done) => {
        if (req.url === '/healthz' || req.url.startsWith('/healthz?')) {
          return done();
        }
        return app.basicAuth(req, reply, done);
      });
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
      authMethod: deps.authMethod,
      agentName: deps.agentName,
      model: deps.model,
      timezone: deps.timezone,
      rateLimitTracker: deps.rateLimitTracker,
      principalUserId: deps.principalUserId,
      botProfile: deps.botProfile,
    }),
  );

  app.register(agentRoutes({ botProfile: deps.botProfile }));

  app.register(
    statsRoutes({
      sessions: deps.sessions,
      timezone: deps.timezone,
    }),
  );

  app.register(
    sessionsRoutes({
      sessions: deps.sessions,
      messages: deps.messages,
      dispatch: deps.dispatch,
      principalUserId: deps.principalUserId,
      liveSessions: deps.liveSessions,
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
