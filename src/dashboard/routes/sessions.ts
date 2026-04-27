import type { FastifyPluginAsync } from 'fastify';
import type { SessionsRepo, SessionStatus } from '../../db/repositories/sessions.js';
import type { MessagesRepo } from '../../db/repositories/messages.js';
import type { AuditRepo } from '../../db/repositories/audit.js';
import type { DispatchDeps } from '../../agent/dispatch.js';
import type { LiveSessionsTracker } from '../../observability/live-sessions.js';
import { dispatchUserPrompt } from '../../agent/dispatch.js';

export interface SessionsRoutesDeps {
  sessions: SessionsRepo;
  messages: MessagesRepo;
  audit: AuditRepo;
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

    // Single-session delete. Cascades messages (FK) + cleans non-FK
    // orphans in memory_proposals + pending_email_sends.
    app.delete<{ Params: { id: string } }>(
      '/api/sessions/:id',
      async (req, reply) => {
        const id = req.params.id;
        const session = deps.sessions.get(id);
        if (!session) {
          reply.code(404);
          return { error: `no session with id ${id}` };
        }
        // Refuse to delete a session that's still running. The dashboard
        // never calls this for a live session, but defend anyway: a
        // delete-mid-stream would leave the dispatch pipeline confused
        // and could double-bill tokens.
        if (session.status === 'running' || session.status === 'queued') {
          reply.code(409);
          return {
            error: `cannot delete a ${session.status} session — wait for it to finish or cancel it first`,
          };
        }
        const result = deps.sessions.remove(id);
        deps.audit.record({
          kind: 'session_deleted',
          actor: 'dashboard',
          detail: { id, ...result, status: session.status },
        });
        return { ok: true, ...result };
      },
    );

    // Bulk delete by id list. Body: { ids: ["...", "..."] }. Each id is
    // looked up + deleted independently — failures (missing id, running
    // session) are returned per-row so the caller can show a partial-
    // success summary. Missing ids are treated as non-fatal (already
    // gone) and reported in `notFound`.
    app.delete<{ Body: { ids?: string[] } }>(
      '/api/sessions',
      async (req, reply) => {
        const ids = Array.isArray(req.body?.ids) ? req.body!.ids! : [];
        if (ids.length === 0) {
          reply.code(400);
          return { error: 'body must be { ids: string[] } with at least one id' };
        }
        if (ids.length > 200) {
          reply.code(400);
          return { error: 'bulk delete limited to 200 ids per call' };
        }
        const deleted: Array<{
          id: string;
          messages: number;
          proposals: number;
          emailSends: number;
        }> = [];
        const skipped: Array<{ id: string; reason: string }> = [];
        const notFound: string[] = [];

        for (const id of ids) {
          const session = deps.sessions.get(id);
          if (!session) {
            notFound.push(id);
            continue;
          }
          if (session.status === 'running' || session.status === 'queued') {
            skipped.push({ id, reason: `${session.status} — wait or cancel first` });
            continue;
          }
          const result = deps.sessions.remove(id);
          deleted.push({
            id,
            messages: result.messages,
            proposals: result.proposals,
            emailSends: result.emailSends,
          });
        }

        deps.audit.record({
          kind: 'session_deleted_bulk',
          actor: 'dashboard',
          detail: {
            requested: ids.length,
            deleted: deleted.length,
            skipped: skipped.length,
            notFound: notFound.length,
          },
        });

        return { deleted, skipped, notFound };
      },
    );
  };
