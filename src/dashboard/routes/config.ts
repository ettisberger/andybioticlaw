import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config/schema.js';
import { HOT_RELOADABLE_PATHS, RESTART_REQUIRED_PATHS } from '../../config/schema.js';

/**
 * Masks secret-like values in config for the dashboard view. We only have
 * a few potentially-sensitive fields (`dashboard.basicAuth.passwordHash`).
 * Everything else is either a non-secret primitive or a scalar array.
 */
function maskedConfig(c: Config): unknown {
  const clone = structuredClone(c);
  if (clone.dashboard.basicAuth.passwordHash) {
    clone.dashboard.basicAuth.passwordHash = '[REDACTED]';
  }
  return clone;
}

export interface ConfigRoutesDeps {
  currentConfig: () => Config;
}

export const configRoutes =
  (deps: ConfigRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/config', async () => {
      // `hotReloadable` and `restartRequired` are the SAME lists that
      // src/config/reload.ts consults — exposed to the dashboard so the
      // Cards view can tag each field with its [live] / [restart] chip
      // without having to re-encode the policy on the frontend.
      return {
        config: maskedConfig(deps.currentConfig()),
        hotReloadable: HOT_RELOADABLE_PATHS,
        restartRequired: RESTART_REQUIRED_PATHS,
      };
    });
  };
