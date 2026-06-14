/**
 * Resolve `{{SECRET_NAME}}` placeholders in `browser_type` text.
 *
 * Secrets injected by the core via the skill's `required_secrets`
 * already exist in `process.env`. The template syntax is intentionally
 * different from the manifest's `${SECRET_NAME}` to make it visually
 * obvious in tool calls that a secret was used (the screenshot
 * recorder consults `usedSecret` to decide whether to suppress the
 * post-action screenshot).
 *
 * Unknown placeholders throw — silently dropping a `{{TOKEN}}` would
 * type the literal "{{TOKEN}}" into the page, which is worse than a
 * clean error.
 */

const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export class SecretMissingError extends Error {
  constructor(name) {
    super(
      `secret {{${name}}} is not declared in this skill's required_secrets ` +
        `(or is declared but unset in .env)`,
    );
    this.name = 'SecretMissingError';
    this.missing = name;
  }
}

/**
 * Resolve placeholders. Returns `{ text, usedSecret }`. `usedSecret`
 * is true iff at least one placeholder was replaced — even if multiple
 * were, the screenshot suppression decision is binary.
 */
export function resolveSecrets(text) {
  if (typeof text !== 'string') return { text: '', usedSecret: false };
  if (!text.includes('{{')) return { text, usedSecret: false };
  let usedSecret = false;
  const out = text.replace(PLACEHOLDER_RE, (_, name) => {
    const value = process.env[name];
    if (value === undefined) throw new SecretMissingError(name);
    usedSecret = true;
    return value;
  });
  return { text: out, usedSecret };
}
