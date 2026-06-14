import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * SKILL.md content substitution at session-assembly time.
 *
 * Today only the `browser` skill uses this — it needs the configured
 * profile list templated in so the agent sees actual names instead of
 * a placeholder. Substitutions are namespaced by skill so a future
 * `{{thing}}` in another skill won't accidentally match.
 *
 * Substitution failures (config missing, no browser block, malformed
 * YAML) fall back to a clear "(no profiles configured)" line — the
 * skill still renders into the agent's prompt, just empty. We never
 * throw from here because that would block the entire session.
 */

export function applySkillTemplating(args: {
  skillName: string;
  content: string;
  configPath: string;
}): string {
  if (args.skillName !== 'browser') return args.content;
  if (!args.content.includes('{{profiles}}')) return args.content;
  return args.content.replace('{{profiles}}', renderBrowserProfiles(args.configPath));
}

function renderBrowserProfiles(configPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return '(no profiles configured — operator must set browser.profiles in config.yaml)';
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return '(config YAML parse error — `andybioticlaw config validate` for details)';
  }
  const block = (parsed as Record<string, unknown>)?.browser as
    | { profiles?: Array<{ name?: unknown; description?: unknown }> }
    | undefined;
  const profiles = Array.isArray(block?.profiles) ? block!.profiles : [];
  const lines: string[] = [];
  for (const p of profiles) {
    if (typeof p?.name !== 'string') continue;
    const desc = typeof p.description === 'string' && p.description.trim()
      ? ` — ${p.description.trim()}`
      : '';
    lines.push(`- \`${p.name}\`${desc}`);
  }
  if (lines.length === 0) {
    return '(no profiles configured — operator must set browser.profiles in config.yaml)';
  }
  return lines.join('\n');
}
