import type { FastifyPluginAsync } from 'fastify';
import type { Config, AgentConfigEntry } from '../../config/schema.js';

export interface AgentsRoutesDeps {
  currentConfig: () => Config;
}

interface AgentView {
  id: string;
  name: string;
  default: boolean;
  model: string;
  haikuModel: string;
  skills: ReadonlyArray<string>;
}

function toView(a: AgentConfigEntry): AgentView {
  return {
    id: a.id,
    name: a.name,
    default: a.default,
    model: a.model,
    haikuModel: a.haikuModel,
    skills: a.skills,
  };
}

export const agentsRoutes =
  (deps: AgentsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /api/agents
     * Lists configured agents. Schema guarantees at least one entry
     * with exactly one default — no fallback path needed.
     */
    app.get('/api/agents', async () => {
      const config = deps.currentConfig();
      return { agents: config.agents.map(toView) };
    });
  };
