import type { FastifyPluginAsync } from 'fastify';
import type { MemoryManager } from '../../memory/manager.js';
import type { MemoryRepo } from '../../db/repositories/memory.js';

export interface MemoryRoutesDeps {
  manager: MemoryManager;
  repo: MemoryRepo;
  principalUserId: number | null;
}

export const memoryRoutes =
  (deps: MemoryRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { scope?: string; limit?: string } }>(
      '/api/memory',
      async (req) => {
        const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
        const entries = req.query.scope
          ? deps.manager.listByScope(req.query.scope, limit)
          : deps.manager.listAll(limit);
        return { entries };
      },
    );

    app.get('/api/memory/active', async () => {
      const snapshot = deps.manager.snapshot(
        {
          principalUserId: deps.principalUserId,
          chatId: deps.principalUserId !== null ? String(deps.principalUserId) : null,
          activeSkills: [],
        },
        100,
      );
      return snapshot;
    });

    app.delete<{ Params: { id: string } }>(
      '/api/memory/:id',
      async (req, reply) => {
        const id = Number(req.params.id);
        const ok = deps.manager.remove(id);
        if (!ok) {
          reply.code(404);
          return { error: 'not found' };
        }
        return { ok: true };
      },
    );

    app.post<{ Params: { id: string }; Body: { pinned?: boolean } }>(
      '/api/memory/:id/pin',
      async (req, reply) => {
        const id = Number(req.params.id);
        const current = deps.repo.get(id);
        if (!current) {
          reply.code(404);
          return { error: 'not found' };
        }
        // If the body specifies `pinned`, honour it; otherwise toggle.
        const next =
          typeof req.body?.pinned === 'boolean' ? req.body.pinned : current.pinned === 0;
        deps.repo.setPinned(id, next);
        return { ok: true, pinned: next };
      },
    );
  };
