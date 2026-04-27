import type { AgentConfigEntry, Config } from './schema.js';

/**
 * Return the agent flagged `default: true`.
 *
 * The schema's refine guarantees exactly one default agent exists, so
 * this never throws at runtime — but the helper narrows the type from
 * `AgentConfigEntry | undefined` (the return of `Array.find`) to
 * `AgentConfigEntry`, which is what every call site needs.
 *
 * Use this everywhere a single-agent shortcut would have been
 * sensible. When code grows agent-aware (per-channel binding pulls a
 * specific agent by id), it should look up by id instead — the
 * default is only the right answer when the caller doesn't already
 * know which agent it's serving.
 */
export function getDefaultAgent(config: Config): AgentConfigEntry {
  const found = config.agents.find((a) => a.default);
  if (!found) {
    // Unreachable per schema refine, but the type system needs the
    // guard. If this ever DOES fire, schema validation is broken.
    throw new Error(
      'getDefaultAgent: no agent has default: true. Schema validation should have caught this.',
    );
  }
  return found;
}
