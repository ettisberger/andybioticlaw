import type { FastifyPluginAsync } from 'fastify';
import { loadPolicies, resolvePolicy } from '../../policies/repo.js';
import type { ResolvedPolicy } from '../../policies/schema.js';

export interface PoliciesRoutesDeps {
  /** Resolves the policies file path. Lazy so the route always reads the
   *  current state — no caching, mirrors the doctor + CLI subcommand
   *  behaviour. */
  policiesPath: () => string;
}

interface PolicyView extends ResolvedPolicy {
  /** Fully-qualified context key, e.g. emma:telegram:18998064. */
  contextKey: string;
}

export const policiesRoutes =
  (deps: PoliciesRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /api/policies
     * Returns the full policies file plus a resolved view for every
     * named context. The dashboard renders both: raw for diff-friendly
     * editing, resolved for the "what does this context actually do"
     * column.
     */
    app.get('/api/policies', async (_req, reply) => {
      const path = deps.policiesPath();
      let file: ReturnType<typeof loadPolicies>;
      try {
        file = loadPolicies(path);
      } catch (e) {
        reply.code(500);
        return { error: (e as Error).message, path };
      }
      if (!file) {
        // Fresh install before first service boot. Surface that
        // explicitly so the UI can show a helpful "auto-generates on
        // next service start" hint instead of an empty page.
        return { exists: false, path };
      }
      const contextKeys = Object.keys(file.contexts);
      const resolved: PolicyView[] = [];
      for (const key of contextKeys) {
        try {
          resolved.push({ contextKey: key, ...resolvePolicy(file, key) });
        } catch (e) {
          // A bad _inherits chain shouldn't 500 the whole list — surface
          // the error in-band per row so the operator can fix it.
          resolved.push({
            contextKey: key,
            scheduleKinds: [],
            scheduleAgentTaskCap: 0,
            execMode: 'deny',
            execAllow: [],
            skillsVisible: [],
            _label: `(error) ${(e as Error).message}`,
          });
        }
      }
      return { exists: true, path, file, resolved };
    });
  };
