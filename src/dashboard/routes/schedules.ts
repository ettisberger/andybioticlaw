import type { FastifyPluginAsync } from 'fastify';
import type { SchedulesRepo } from '../../db/repositories/schedules.js';

export interface SchedulesRoutesDeps {
  schedules: SchedulesRepo;
  /** Signal the engine to refresh (sends SIGHUP to self in prod). */
  onMutate: () => void;
}

export const schedulesRoutes =
  (deps: SchedulesRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/schedules', async () => {
      return { schedules: deps.schedules.list() };
    });

    app.get<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
      const id = Number(req.params.id);
      const row = deps.schedules.get(id);
      if (!row) {
        reply.code(404);
        return { error: 'not found' };
      }
      const runs = deps.schedules.listRuns(id, 20);
      return { schedule: row, runs };
    });

    app.post<{ Params: { id: string } }>(
      '/api/schedules/:id/enable',
      async (req, reply) => {
        const id = Number(req.params.id);
        if (!deps.schedules.get(id)) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.schedules.update(id, { enabled: true, consecutive_fails: 0 });
        deps.onMutate();
        return { ok: true };
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/schedules/:id/disable',
      async (req, reply) => {
        const id = Number(req.params.id);
        if (!deps.schedules.get(id)) {
          reply.code(404);
          return { error: 'not found' };
        }
        deps.schedules.update(id, { enabled: false });
        deps.onMutate();
        return { ok: true };
      },
    );
  };
