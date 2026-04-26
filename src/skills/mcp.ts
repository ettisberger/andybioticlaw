import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SkillRecord } from './registry.js';

export interface McpConfigInput {
  /** Active skills for this session. Each contributes its mcp_servers list. */
  skills: readonly SkillRecord[];
  /**
   * Core memory-proposal MCP server config. Produced by the main service so
   * the path to `memory-proposal-server.js` and the session-scoped env vars
   * (DB path, session id, chat id) land correctly.
   */
  memoryProposalServer?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  /**
   * Env vars injected into every spawned skill MCP server. Carries framework
   * essentials the server needs to function (PATH, HOME, NODE_ENV) plus
   * session-scoped context (`ANDYBIOTICLAW_DB_PATH`, `_SESSION_ID`, `_CHAT_ID`)
   * that any skill is allowed to read without declaring it as a secret. Skill
   * manifest `env` blocks layer on top — keys collide → manifest wins, which
   * is what you want when a skill needs a different PATH or to redirect the DB.
   */
  frameworkEnv?: Record<string, string>;
  /** Resolver for skill secret values. Returns `undefined` if the secret is not set. */
  getSkillSecret: (skillName: string, secretName: string) => string | undefined;
}

export interface McpConfig {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;
}

/**
 * Build the `.mcp.json` Claude Code reads via `--mcp-config`.
 *
 * Secret interpolation: each skill's `mcp_servers[].env` values can reference
 * the skill's declared secrets as `${SECRET_NAME}`. We resolve those via the
 * scoped secrets store (enforced by the skill's `required_secrets`).
 *
 * Unresolved references (e.g. the env var is declared but unset) are replaced
 * with empty string AND reported in the `warnings` array so the caller can
 * alert the operator rather than silently launching a broken server.
 */
export function buildMcpConfig(
  input: McpConfigInput,
): { config: McpConfig; warnings: string[] } {
  const warnings: string[] = [];
  const servers: McpConfig['mcpServers'] = {};

  if (input.memoryProposalServer) {
    servers['andybioticlaw-memory'] = {
      command: input.memoryProposalServer.command,
      args: [...input.memoryProposalServer.args],
      env: { ...input.memoryProposalServer.env },
    };
  }

  for (const skill of input.skills) {
    for (const srv of skill.mcpServers) {
      if (servers[srv.name]) {
        warnings.push(
          `mcp server name collision on "${srv.name}" between ${Object.keys(servers).find(() => true) ?? 'core'} and skill "${skill.name}" — skipping duplicate`,
        );
        continue;
      }
      const env: Record<string, string> = { ...(input.frameworkEnv ?? {}) };
      for (const [k, template] of Object.entries(srv.env)) {
        const interpolated = template.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
          // The secret must have been declared in required_secrets for us to
          // be willing to inject it — otherwise throw a scope violation at
          // the secrets-manager level (handled by getSkillSecret).
          if (!skill.requiredSecrets.includes(name)) {
            warnings.push(
              `skill "${skill.name}" mcp server "${srv.name}" references secret "${name}" not in required_secrets`,
            );
            return '';
          }
          const value = input.getSkillSecret(skill.name, name);
          if (value === undefined) {
            warnings.push(
              `skill "${skill.name}" mcp server "${srv.name}" references secret "${name}" which is unset`,
            );
            return '';
          }
          return value;
        });
        env[k] = interpolated;
      }
      // Relative paths in args (and command) are resolved against the
      // skill's own directory. The Claude CLI spawns MCP servers with its
      // own cwd (the agent workspace, not the skill dir), so manifests
      // that write `./mcp-server/index.js` meaning "relative to my skill
      // folder" would otherwise silently fail to start.
      const resolvedCommand = looksLikePath(srv.command)
        ? resolvePathAgainstSkill(srv.command, skill.skillDir)
        : srv.command;
      const resolvedArgs = srv.args.map((a) =>
        looksLikePath(a) ? resolvePathAgainstSkill(a, skill.skillDir) : a,
      );
      servers[srv.name] = {
        command: resolvedCommand,
        args: resolvedArgs,
        env,
      };
    }
  }

  return { config: { mcpServers: servers }, warnings };
}

export function writeMcpConfig(path: string, config: McpConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function mcpConfigPath(sessionWorkspace: string): string {
  return resolve(sessionWorkspace, '.mcp.json');
}

/**
 * Heuristic for "this string refers to a file inside the skill folder" —
 * i.e. starts with `./`, `../`, or is already absolute. Bare names
 * (`node`, `python3`, `himalaya`) are left alone so they resolve via PATH.
 */
function looksLikePath(s: string): boolean {
  return s.startsWith('./') || s.startsWith('../') || isAbsolute(s);
}

function resolvePathAgainstSkill(s: string, skillDir: string): string {
  return isAbsolute(s) ? s : resolve(skillDir, s);
}
