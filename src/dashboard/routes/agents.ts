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
  /** True when the entry came from the new `agents:` block; false when
   *  synthesised from the legacy `agent:` block during the deprecation
   *  window. The UI uses this to show a "legacy single-agent" hint. */
  fromLegacy: boolean;
}

function fromLegacy(c: Config): AgentView {
  return {
    id: 'emma',
    name: c.agent.name,
    default: true,
    model: c.agent.model,
    haikuModel: c.agent.haikuModel,
    skills: ['*'],
    fromLegacy: true,
  };
}

function fromExplicit(a: AgentConfigEntry): AgentView {
  return {
    id: a.id,
    name: a.name,
    default: a.default,
    model: a.model,
    haikuModel: a.haikuModel,
    skills: a.skills,
    fromLegacy: false,
  };
}

export const agentsRoutes =
  (deps: AgentsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /api/agents
     * Lists configured agents. During the deprecation window, an
     * install with only `agent:` (no `agents:`) returns a single
     * synthesized 'emma' entry with `fromLegacy: true`.
     */
    app.get('/api/agents', async () => {
      const config = deps.currentConfig();
      const agents =
        config.agents && config.agents.length > 0
          ? config.agents.map(fromExplicit)
          : [fromLegacy(config)];
      return { agents };
    });
  };
