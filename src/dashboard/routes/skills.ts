import type { FastifyPluginAsync } from 'fastify';
import type { SkillRegistry } from '../../skills/registry.js';

export interface SkillsRoutesDeps {
  skills: SkillRegistry;
}

export const skillsRoutes =
  (deps: SkillsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/skills', async () => {
      return {
        skills: deps.skills.list().map((s) => ({
          name: s.name,
          version: s.version,
          description: s.description,
          enabled: s.enabled,
          scope: s.scope,
          requiredSecrets: s.requiredSecrets,
          mcpServerCount: s.mcpServers.length,
        })),
      };
    });
  };
