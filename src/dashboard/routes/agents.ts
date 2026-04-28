import { readFileSync, writeFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import type {
  AgentConfigEntry,
  Config,
} from '../../config/schema.js';
import {
  HOT_RELOADABLE_PATHS,
  RESTART_REQUIRED_PATHS,
} from '../../config/schema.js';
import { loadConfig } from '../../config/load.js';
import {
  applyAgentPatch,
  AgentPatchError,
  type AgentPatch,
  type AgentSkillsValue,
} from '../../config/agent-yaml-edit.js';
import type { AuditRepo } from '../../db/repositories/audit.js';

export interface AgentsRoutesDeps {
  currentConfig: () => Config;
  /** Absolute path to the editable config.yaml. */
  configPath: string;
  /**
   * Trigger an in-process config reload (same path SIGHUP would
   * take). For hot-reloadable fields (haikuModel, routing.*) the
   * service picks up the new value without a restart; for
   * restart-required fields (model, skills) reload logs a warn but
   * keeps the old in-memory value.
   */
  reload: () => void;
  audit: AuditRepo;
}

interface AgentView {
  id: string;
  name: string;
  default: boolean;
  model: string;
  haikuModel: string;
  skills: ReadonlyArray<string>;
  routing: { enabled: boolean; minCharsForOpus: number };
}

function toView(a: AgentConfigEntry): AgentView {
  return {
    id: a.id,
    name: a.name,
    default: a.default,
    model: a.model,
    haikuModel: a.haikuModel,
    skills: a.skills,
    routing: a.routing,
  };
}

interface PatchBody {
  model?: unknown;
  haikuModel?: unknown;
  routing?: {
    enabled?: unknown;
    minCharsForOpus?: unknown;
  };
  skills?: unknown;
}

/**
 * Coerce + validate the request body into an `AgentPatch`. Returns
 * either the cleaned patch or an error string. We only accept the
 * fields the dashboard form can produce; anything else is dropped.
 */
function parsePatch(
  body: PatchBody,
): { patch: AgentPatch } | { error: string } {
  const patch: AgentPatch = {};

  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      return { error: 'model must be a non-empty string' };
    }
    patch.model = body.model.trim();
  }
  if (body.haikuModel !== undefined) {
    if (typeof body.haikuModel !== 'string' || body.haikuModel.trim() === '') {
      return { error: 'haikuModel must be a non-empty string' };
    }
    patch.haikuModel = body.haikuModel.trim();
  }
  if (body.routing !== undefined) {
    if (typeof body.routing !== 'object' || body.routing === null) {
      return { error: 'routing must be an object' };
    }
    patch.routing = {};
    if (body.routing.enabled !== undefined) {
      if (typeof body.routing.enabled !== 'boolean') {
        return { error: 'routing.enabled must be boolean' };
      }
      patch.routing.enabled = body.routing.enabled;
    }
    if (body.routing.minCharsForOpus !== undefined) {
      if (
        typeof body.routing.minCharsForOpus !== 'number' ||
        !Number.isInteger(body.routing.minCharsForOpus) ||
        body.routing.minCharsForOpus < 0
      ) {
        return {
          error: 'routing.minCharsForOpus must be a non-negative integer',
        };
      }
      patch.routing.minCharsForOpus = body.routing.minCharsForOpus;
    }
  }
  if (body.skills !== undefined) {
    if (body.skills === '*') {
      patch.skills = '*' as AgentSkillsValue;
    } else if (Array.isArray(body.skills)) {
      const filtered = body.skills.filter(
        (s): s is string => typeof s === 'string',
      );
      patch.skills = filtered;
    } else {
      return { error: 'skills must be "*" or a string array' };
    }
  }

  if (Object.keys(patch).length === 0) {
    return { error: 'patch is empty' };
  }
  return { patch };
}

/**
 * For a given patch, classify which fields are hot-reloadable. We
 * use the per-agent variant of the path (`agents.<index>.field`) so
 * the answer is correct even after a multi-agent setup; today the
 * lists in schema.ts only enumerate `agents.0.*` so non-default
 * agents always count as restart-required (acceptable — no second
 * agent today, and we'd revisit when it arrives).
 */
function fieldsRequiringRestart(
  patch: AgentPatch,
  agentIndex: number,
): string[] {
  const touched: string[] = [];
  if (patch.model !== undefined) touched.push(`agents.${agentIndex}.model`);
  if (patch.haikuModel !== undefined)
    touched.push(`agents.${agentIndex}.haikuModel`);
  if (patch.routing?.enabled !== undefined)
    touched.push(`agents.${agentIndex}.routing.enabled`);
  if (patch.routing?.minCharsForOpus !== undefined)
    touched.push(`agents.${agentIndex}.routing.minCharsForOpus`);
  if (patch.skills !== undefined) touched.push(`agents.${agentIndex}.skills`);

  const hot = new Set(HOT_RELOADABLE_PATHS);
  const restart = new Set(RESTART_REQUIRED_PATHS);
  return touched.filter((p) => !hot.has(p) || restart.has(p));
}

export const agentsRoutes =
  (deps: AgentsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /api/agents
     * Lists configured agents from the in-memory config (which
     * mirrors disk after every reload). Schema guarantees at least
     * one entry with exactly one default.
     */
    app.get('/api/agents', async () => {
      const config = deps.currentConfig();
      return { agents: config.agents.map(toView) };
    });

    /**
     * PATCH /api/agents/:id
     * Edit one agent. Body accepts {model?, haikuModel?, routing?,
     * skills?}. Reads config.yaml from disk, applies the patch,
     * re-validates via the existing Zod schema, writes back, then
     * triggers a config reload. The response includes which fields
     * changed and which require a restart to take effect.
     */
    app.patch<{ Params: { id: string }; Body: PatchBody }>(
      '/api/agents/:id',
      async (req, reply) => {
        const agentId = req.params.id;
        const config = deps.currentConfig();
        const agentIndex = config.agents.findIndex((a) => a.id === agentId);
        if (agentIndex < 0) {
          reply.code(404);
          return { error: `no agent with id "${agentId}"` };
        }

        const parsed = parsePatch(req.body ?? {});
        if ('error' in parsed) {
          reply.code(400);
          return { error: parsed.error };
        }

        // Read current YAML, apply, validate, write.
        let nextYaml: string;
        try {
          const yaml = readFileSync(deps.configPath, 'utf8');
          nextYaml = applyAgentPatch(yaml, agentId, parsed.patch);
        } catch (e) {
          if (e instanceof AgentPatchError) {
            reply.code(400);
            return { error: e.message, kind: e.kind };
          }
          reply.code(500);
          return { error: `failed to read/patch config: ${(e as Error).message}` };
        }

        // Pre-write validation — never put invalid YAML on disk.
        // loadConfig() reads the path on disk, so we have to write
        // first, validate, and roll back on failure. To stay safe,
        // we keep the prior bytes in memory and rewrite if Zod
        // rejects.
        const prior = readFileSync(deps.configPath, 'utf8');
        writeFileSync(deps.configPath, nextYaml);
        try {
          loadConfig();
        } catch (e) {
          writeFileSync(deps.configPath, prior);
          reply.code(400);
          return {
            error: `validation failed after patch — config rolled back: ${(e as Error).message}`,
          };
        }

        // Refresh the running service's in-memory config.
        deps.reload();

        const restartFields = fieldsRequiringRestart(parsed.patch, agentIndex);

        deps.audit.record({
          kind: 'agent_updated',
          actor: 'dashboard',
          detail: {
            agentId,
            fields: Object.keys(parsed.patch),
            restartRequired: restartFields,
          },
        });

        const updated = deps.currentConfig().agents.find((a) => a.id === agentId);
        return {
          agent: updated ? toView(updated) : null,
          restartRequired: restartFields,
        };
      },
    );
  };
