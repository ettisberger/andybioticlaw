/**
 * Targeted, comment-preserving YAML patches for fields under a
 * specific agent in `config.yaml`.
 *
 * Why a regex patcher instead of round-tripping through a YAML
 * library: we want operator-authored comments inside the agent
 * block to survive a dashboard edit. js-yaml's `dump()` would strip
 * them. The eemeli `yaml` package preserves comments via its
 * Document API but adds a dep we don't currently have. The CLI
 * settings menu has used the same regex approach for the whole
 * lifetime of this project (see `src/cli/settings/yaml.ts`); this
 * file extends it with id-aware slicing so per-agent edits target
 * the right block.
 *
 * The shape we lock onto:
 *
 *     agents:
 *       - id: emma
 *         name: Emma
 *         model: claude-opus-4-7
 *         haikuModel: claude-haiku-4-5-20251001
 *         skills: ['*']
 *         routing:
 *           enabled: false
 *           minCharsForOpus: 120
 *       - id: work
 *         …
 *
 * Anchor: a `- id: <id>` line at agent-array indent. Slice: from
 * that line up to the next `- id:` at the same indent (or end of
 * file). Within the slice, each leaf field appears on its own line
 * exactly once — so a per-line regex within the slice is safe.
 */

export type AgentSkillsValue = '*' | ReadonlyArray<string>;

export interface AgentPatch {
  model?: string;
  haikuModel?: string;
  routing?: {
    enabled?: boolean;
    minCharsForOpus?: number;
  };
  skills?: AgentSkillsValue;
}

export class AgentPatchError extends Error {
  constructor(
    public readonly kind:
      | 'agent_not_found'
      | 'field_not_found'
      | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'AgentPatchError';
  }
}

/**
 * Apply a partial update to a single agent in `yaml` and return the
 * new YAML text. Throws AgentPatchError if the agent isn't found,
 * if any requested field is missing in that agent's block (we
 * never inject new keys — operator edits the YAML to add a missing
 * field), or if a value fails sanity validation.
 *
 * Comments + non-targeted lines are byte-identical between input
 * and output.
 */
export function applyAgentPatch(
  yaml: string,
  agentId: string,
  patch: AgentPatch,
): string {
  let result = yaml;

  if (patch.model !== undefined) {
    result = patchScalarField(result, agentId, 'model', patch.model);
  }
  if (patch.haikuModel !== undefined) {
    result = patchScalarField(result, agentId, 'haikuModel', patch.haikuModel);
  }
  if (patch.routing?.enabled !== undefined) {
    result = patchScalarField(
      result,
      agentId,
      'enabled',
      patch.routing.enabled ? 'true' : 'false',
    );
  }
  if (patch.routing?.minCharsForOpus !== undefined) {
    if (
      !Number.isInteger(patch.routing.minCharsForOpus) ||
      patch.routing.minCharsForOpus < 0
    ) {
      throw new AgentPatchError(
        'invalid_value',
        `minCharsForOpus must be a non-negative integer, got ${patch.routing.minCharsForOpus}`,
      );
    }
    result = patchScalarField(
      result,
      agentId,
      'minCharsForOpus',
      String(patch.routing.minCharsForOpus),
    );
  }
  if (patch.skills !== undefined) {
    result = patchScalarField(
      result,
      agentId,
      'skills',
      renderSkillsArray(patch.skills),
    );
  }
  return result;
}

/** `['*']` shorthand survives if every skill is selected; otherwise an explicit list. */
function renderSkillsArray(skills: AgentSkillsValue): string {
  if (skills === '*') return `['*']`;
  if (skills.length === 0) return `[]`;
  // Validate each entry — bare-word safe (no spaces, no quotes, no
  // brackets) so single-quote wrapping is enough.
  for (const s of skills) {
    if (!/^[A-Za-z0-9_*-]+$/.test(s)) {
      throw new AgentPatchError(
        'invalid_value',
        `skill name "${s}" contains invalid characters`,
      );
    }
  }
  return `[${skills.map((s) => `'${s}'`).join(', ')}]`;
}

/**
 * Replace one scalar field's value within the named agent's block.
 * `field` is the bare YAML key (no leading whitespace, no colon).
 * The line's indent + key + colon + spacing are preserved; only the
 * value to the right is rewritten.
 */
function patchScalarField(
  yaml: string,
  agentId: string,
  field: string,
  newValue: string,
): string {
  const slice = locateAgentSlice(yaml, agentId);
  if (slice === null) {
    throw new AgentPatchError(
      'agent_not_found',
      `no agent with id "${agentId}" in config.yaml`,
    );
  }
  // Within [start, end), find the LAST occurrence of `^\s+<field>:`
  // — "last" because for `enabled` we want the routing.enabled
  // nested under this agent, not the top-level enabled (none exists
  // today, but defensive). For all our fields, exactly one match per
  // agent. We use a non-global regex with manual offset tracking so
  // we can scope to the slice.
  const block = yaml.slice(slice.start, slice.end);
  const fieldRe = new RegExp(
    `^(\\s+)${escapeRegex(field)}:[ \\t]*([^\\n]*)$`,
    'm',
  );
  const m = block.match(fieldRe);
  if (!m || m.index === undefined) {
    throw new AgentPatchError(
      'field_not_found',
      `agent "${agentId}" has no \`${field}:\` line — add it to config.yaml manually first`,
    );
  }
  const lineStart = slice.start + m.index;
  const lineEnd = lineStart + m[0].length;
  const indent = m[1];
  const replacement = `${indent}${field}: ${newValue}`;
  return yaml.slice(0, lineStart) + replacement + yaml.slice(lineEnd);
}

interface AgentSlice {
  /** Byte offset of the first character of the `- id: <agentId>` line. */
  start: number;
  /** Byte offset just after the last character of the agent's last line. */
  end: number;
}

/**
 * Find the slice of `yaml` covering one agent's block. The block
 * starts at `- id: <agentId>` and ends at the next sibling
 * `- id: ...` line (same indent) or at end-of-file.
 */
function locateAgentSlice(yaml: string, agentId: string): AgentSlice | null {
  // Match `- id: <agentId>` at any indent. We capture the indent so
  // we can find the next sibling.
  const idRe = new RegExp(
    `^([ \\t]*)-[ \\t]+id:[ \\t]+${escapeRegex(agentId)}[ \\t]*$`,
    'm',
  );
  const idMatch = yaml.match(idRe);
  if (!idMatch || idMatch.index === undefined) return null;

  const start = idMatch.index;
  const indent = idMatch[1];

  // Find the next `- id:` line at the same indent, after this match.
  const siblingRe = new RegExp(`^${indent}-[ \\t]+id:`, 'gm');
  siblingRe.lastIndex = start + idMatch[0].length;
  const sibling = siblingRe.exec(yaml);

  // Or the next top-level YAML key (no leading whitespace) — that
  // ends the `agents:` array as a whole.
  const topLevelRe = /^[A-Za-z_]/gm;
  topLevelRe.lastIndex = start + idMatch[0].length;
  const topLevel = topLevelRe.exec(yaml);

  let end = yaml.length;
  if (sibling) end = Math.min(end, sibling.index);
  if (topLevel) end = Math.min(end, topLevel.index);
  return { start, end };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
