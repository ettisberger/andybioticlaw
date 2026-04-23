import type { FastifyPluginAsync } from 'fastify';
import type { BotProfile } from '../../telegram/bot.js';

export interface AgentRoutesDeps {
  botProfile: () => BotProfile | null;
}

/**
 * Serves the cached Telegram bot avatar as a raw image. Returns 404 when
 * the bot hasn't fetched its profile yet OR has no profile photo set.
 * The frontend falls back to the Bot lucide icon in that case.
 *
 * Cached for 1h by the browser — operators wanting an avatar change
 * visible immediately can restart the service (or hard-refresh).
 */
export const agentRoutes =
  (deps: AgentRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/agent/avatar', async (_req, reply) => {
      const profile = deps.botProfile();
      if (!profile || !profile.avatar) {
        reply.code(404);
        return { error: 'no_avatar' };
      }
      reply.header('content-type', profile.avatar.contentType);
      reply.header('cache-control', 'public, max-age=3600');
      return profile.avatar.data;
    });
  };
