import { bold, dim, lavender } from './ansi.js';

/**
 * Canonical section header for every interactive CLI flow (init wizard,
 * edit-config, skill setup, skill menu, installer preview, ...). One
 * format means the operator visually recognises "you're in a flow" the
 * same way in every command.
 *
 *   ── step · Title ──
 *
 * `step` can be `"1/5"`, `"install"`, a skill name — anything short
 * identifying the phase. `title` is the human-readable heading.
 *
 * Surrounding blank lines are baked in so callers don't have to juggle
 * `\n` counts.
 */
export function section(
  stdout: NodeJS.WritableStream,
  step: string,
  title: string,
): void {
  stdout.write(
    `\n${dim('──')} ${lavender(step)} ${dim('·')} ${bold(title)} ${dim('──')}\n\n`,
  );
}
