import type { FastifyPluginAsync } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillRegistry, SkillRecord } from '../../skills/registry.js';

const pexec = promisify(execFile);

export interface SkillsRoutesDeps {
  skills: SkillRegistry;
}

interface SkillResponse {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  scope: string[];
  /** Each required secret with presence boolean. Names only — never values. */
  secrets: Array<{ name: string; present: boolean }>;
  mcpServers: Array<{ name: string; command: string }>;
  systemCommands: string[];
  /** `null` when the skill declares no system_commands, true iff every one
   *  resolves on PATH, false if any is missing. */
  systemCommandsOk: boolean | null;
  installedAt: number | null;
  lastEnabledAt: number | null;
  lastDisabledAt: number | null;
  lastInstallOutput: string | null;
  hasSetupWizard: boolean;
}

async function systemCommandExists(cmd: string): Promise<boolean> {
  try {
    await pexec('/bin/sh', ['-c', `command -v ${cmd.replace(/'/g, "'\\''")}`]);
    return true;
  } catch {
    return false;
  }
}

async function buildSkillResponse(
  skill: SkillRecord,
  skills: SkillRegistry,
): Promise<SkillResponse> {
  const state = skills.getState(skill.name);
  const secrets = skill.requiredSecrets.map((name) => {
    const v = process.env[name];
    return { name, present: typeof v === 'string' && v.trim() !== '' };
  });
  let systemCommandsOk: boolean | null = null;
  if (skill.systemCommands.length > 0) {
    const checks = await Promise.all(
      skill.systemCommands.map((c) => systemCommandExists(c)),
    );
    systemCommandsOk = checks.every(Boolean);
  }
  return {
    name: skill.name,
    version: skill.version,
    description: skill.description,
    enabled: skill.enabled,
    scope: [...skill.scope],
    secrets,
    mcpServers: skill.mcpServers.map((m) => ({
      name: m.name,
      command: m.command,
    })),
    systemCommands: [...skill.systemCommands],
    systemCommandsOk,
    installedAt: state?.installed_at ?? null,
    lastEnabledAt: state?.last_enabled_at ?? null,
    lastDisabledAt: state?.last_disabled_at ?? null,
    lastInstallOutput: state?.last_install_output ?? null,
    hasSetupWizard: skill.setupWizard != null,
  };
}

export const skillsRoutes =
  (deps: SkillsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    // GET /api/skills — list all skills, enriched with secret presence,
    // install state, and system-command availability.
    app.get('/api/skills', async () => {
      const skills = deps.skills.list();
      const enriched = await Promise.all(
        skills.map((s) => buildSkillResponse(s, deps.skills)),
      );
      return { skills: enriched };
    });

    // POST /api/skills/:name/enable — toggle a skill on. Returns updated record.
    app.post<{ Params: { name: string } }>(
      '/api/skills/:name/enable',
      async (req, reply) => {
        const skill = deps.skills.get(req.params.name);
        if (!skill) {
          reply.code(404);
          return { error: 'not_found', name: req.params.name };
        }
        deps.skills.setEnabled(skill.name, true);
        // Re-read to get the now-updated record.
        const updated = deps.skills.get(skill.name);
        if (!updated) {
          reply.code(500);
          return { error: 'state_inconsistent' };
        }
        return await buildSkillResponse(updated, deps.skills);
      },
    );

    app.post<{ Params: { name: string } }>(
      '/api/skills/:name/disable',
      async (req, reply) => {
        const skill = deps.skills.get(req.params.name);
        if (!skill) {
          reply.code(404);
          return { error: 'not_found', name: req.params.name };
        }
        deps.skills.setEnabled(skill.name, false);
        const updated = deps.skills.get(skill.name);
        if (!updated) {
          reply.code(500);
          return { error: 'state_inconsistent' };
        }
        return await buildSkillResponse(updated, deps.skills);
      },
    );
  };
