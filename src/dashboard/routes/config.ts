import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../../config/schema.js';
import {
  HOT_RELOADABLE_PATHS,
  RESTART_REQUIRED_PATHS,
  isHotReloadable,
  isRestartRequired,
} from '../../config/schema.js';

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
      // `hotReloadable` and `restartRequired` mirror what
      // `src/config/reload.ts` would classify each path as. The static
      // arrays cover non-agent paths; per-agent paths
      // (`agents.<i>.<field>`) are expanded from the live config so the
      // dashboard's Cards view can tag every field — including
      // non-default agents — with its [live] / [restart] chip.
      const cfg = deps.currentConfig();
      const perAgentFields = [
        'name',
        'model',
        'haikuModel',
        'skills',
        'credentialsDir',
        'streamIdleTimeoutSec',
        'routing.enabled',
        'routing.minCharsForOpus',
        'systemPromptFile',
        'tokenEnvVar',
      ];
      const hot: string[] = [...HOT_RELOADABLE_PATHS];
      const restart: string[] = [...RESTART_REQUIRED_PATHS];
      for (let i = 0; i < cfg.agents.length; i++) {
        for (const field of perAgentFields) {
          const path = `agents.${i}.${field}`;
          if (isHotReloadable(path)) hot.push(path);
          else if (isRestartRequired(path)) restart.push(path);
        }
      }
      return {
        config: maskedConfig(cfg),
        hotReloadable: hot,
        restartRequired: restart,
      };
    });
  };
