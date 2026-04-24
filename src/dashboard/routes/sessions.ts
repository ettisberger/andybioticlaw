import type { FastifyPluginAsync } from 'fastify';
import type { SessionsRepo, SessionStatus } from '../../db/repositories/sessions.js';
import type { MessagesRepo } from '../../db/repositories/messages.js';
import type { DispatchDeps } from '../../agent/dispatch.js';
import type { LiveSessionsTracker } from '../../observability/live-sessions.js';
import { dispatchUserPrompt } from '../../agent/dispatch.js';

export interface SessionsRoutesDeps {
  sessions: SessionsRepo;
  messages: MessagesRepo;
  /** Null when the bot is disabled — retry endpoint returns 503. */
  dispatch: DispatchDeps | null;
  principalUserId: number | null;
  liveSessions: LiveSessionsTracker;
}

export const sessionsRoutes =
  (deps: SessionsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get<{
      Querystring: { status?: SessionStatus; limit?: string };
    }>('/api/sessions', async (req) => {
      const statusStr = req.query.status;
      const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
      const opts: { status?: SessionStatus; limit?: number } = { limit };
      if (statusStr) opts.status = statusStr;
      return { sessions: deps.sessions.list(opts) };
    });

    // `/api/sessions/live` MUST be declared before the `/:id` route so
    // Fastify doesn't try to look up a session with id="live".
    app.get('/api/sessions/live', async () => {
      return { live: deps.liveSessions.snapshot() };
    });

    app.get<{ Params: { id: string } }>('/api/sessions/:id/live', async (req, reply) => {
      const live = deps.liveSessions.snapshotOne(req.params.id);
      if (!live) {
        reply.code(404);
        return { error: `no live session with id ${req.params.id}` };
      }
      return { live };
    });

    app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
      const session = deps.sessions.get(req.params.id);
      if (!session) {
        reply.code(404);
        return { error: `no session with id ${req.params.id}` };
      }
      const msgs = session.source_ref
        ? deps.messages.latestByChat(session.source_ref, 50)
        : [];
      return { session, messages: msgs };
    });

    app.post<{ Params: { id: string } }>(
      '/api/sessions/:id/retry',
      async (req, reply) => {
        const prior = deps.sessions.get(req.params.id);
        if (!prior) {
          reply.code(404);
          return { error: `no session with id ${req.params.id}` };
        }
        if (prior.source !== 'dm') {
          reply.code(400);
          return { error: 'only dm sessions can be retried from the dashboard' };
        }
        if (!prior.input_preview) {
          reply.code(400);
          return { error: 'no recoverable input on prior session' };
        }
        if (!prior.source_ref) {
          reply.code(400);
          return { error: 'no chat id on prior session' };
        }
        if (!deps.dispatch) {
          reply.code(503);
          return { error: 'bot is disabled — retry not available without telegram' };
        }

        const chatId = Number(prior.source_ref);
        if (!Number.isFinite(chatId)) {
          reply.code(500);
          return { error: `invalid chatId on prior session: ${prior.source_ref}` };
        }

        const outcome = await dispatchUserPrompt(
          {
            chatId,
            userText: prior.input_preview,
            fromUserId: deps.principalUserId,
            origin: 'dashboard-retry',
            retryOfSessionId: prior.id,
          },
          deps.dispatch,
          deps.principalUserId,
        );

        if (outcome.kind === 'refused') {
          reply.code(409);
          return { error: outcome.reason, userMessage: outcome.userMessage };
        }
        return { sessionId: outcome.sessionId, retryOf: prior.id };
      },
    );
  };
