import type { FastifyPluginAsync } from 'fastify';
import type { AuditRepo } from '../../db/repositories/audit.js';

export interface AuditRoutesDeps {
  audit: AuditRepo;
}

export const auditRoutes =
  (deps: AuditRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { kind?: string; limit?: string } }>(
      '/api/audit',
      async (req) => {
        const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
        const opts: { kind?: string; limit: number } = { limit };
        if (req.query.kind) opts.kind = req.query.kind;
        return { entries: deps.audit.list(opts) };
      },
    );
  };
