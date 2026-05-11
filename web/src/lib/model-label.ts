/**
 * Pure helpers for rendering a Claude model id on the sessions list.
 *
 * Model ids look like `claude-<family>-<major>-<minor>[-<datestamp>]`,
 * e.g. `claude-opus-4-7`, `claude-haiku-4-5-20251001`. The full id is
 * accurate but noisy; the dashboard only needs the family and version.
 *
 * Lives next to `pricing.ts` (same kind of small co-located pure
 * helper that the SessionsPage already pulls in).
 */

type ModelTone = 'accent' | 'info' | 'success' | 'neutral';

const FALLBACK_LABEL = '—';

const FAMILY_TONE: Record<string, ModelTone> = {
  opus: 'accent',    // premium tier
  sonnet: 'info',    // mid tier
  haiku: 'success',  // cheap tier
};

/**
 * Match `claude-<family>-<major>-<minor>` with optional `-YYYYMMDD`
 * datestamp. The major/minor parts get joined back with a dot for
 * display ("4-7" → "4.7"). Unknown families fall through to a
 * best-effort capitalize.
 */
const MODEL_ID_RE = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/;

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function formatModelLabel(id: string | null | undefined): string {
  if (!id) return FALLBACK_LABEL;
  const m = MODEL_ID_RE.exec(id);
  if (!m) return id; // unknown shape — show the raw id rather than swallow it
  const [, family, major, minor] = m;
  return `${capitalize(family!)} ${major}.${minor}`;
}

export function modelTone(id: string | null | undefined): ModelTone {
  if (!id) return 'neutral';
  const m = MODEL_ID_RE.exec(id);
  if (!m) return 'neutral';
  return FAMILY_TONE[m[1]!] ?? 'neutral';
}
