import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config/schema.js';

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
      return { config: maskedConfig(deps.currentConfig()) };
    });
  };
