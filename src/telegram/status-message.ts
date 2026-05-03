/**
 * Pure builder for the boot-time Telegram status notification.
 *
 * Called from `src/index.ts` once after `telegram.start()`, when
 * `config.telegram.statusMessage.enabled` is true. The message goes
 * to the principal chat via `sendTelegramHtml` (HTML parse_mode +
 * plain-text fallback for malformed entities — though this builder
 * only emits well-formed HTML, the fallback is defense-in-depth).
 *
 * The format is intentionally short (4-5 lines). Operators want
 * "is the bot up?" answered in one glance, not a full status
 * dashboard. For deeper info there's the `andybioticlaw doctor`
 * command and the dashboard.
 *
 * Pure: no fs, no clock, no config. Inputs are passed in and
 * snapshot-tested. The caller in `src/index.ts` does the wiring.
 */

import { htmlEscape } from './streaming.js';

export interface StatusMessageInput {
  /** Display name of the agent whose persona owns the boot notice. */
  agentName: string;
  /** Total agents in `config.agents`. Triggers the "👥 N agents" line when > 1. */
  agentCount: number;
  /** ID of the agent with `default: true` — labelled in the agents line. */
  defaultAgentId: string;
  /** From package.json. Includes the leading "v". */
  version: string;
  /** `enabled` skills in the registry. */
  skillsLoaded: number;
  /** Schedules where `enabled === 1`. */
  activeSchedules: number;
  /** Boot timestamp; rendered as HH:MM in the service timezone. */
  startedAt: Date;
  /** IANA timezone name, e.g. `Europe/Zurich`. */
  timezone: string;
}

/**
 * Render the boot-status message body. Returns Telegram-HTML.
 *
 * Single-agent example:
 *
 *     🤖 <b>Emma online</b>
 *
 *     📦 v0.22.16
 *     🛠 4 skills · ⏰ 12 schedules
 *     🌍 Started 14:23 (Europe/Zurich)
 *
 * Multi-agent variant adds an extra line:
 *
 *     🤖 <b>Emma online</b>
 *
 *     📦 v0.22.16
 *     👥 2 agents · default: emma
 *     🛠 4 skills · ⏰ 12 schedules
 *     🌍 Started 14:23 (Europe/Zurich)
 */
export function buildStatusMessage(i: StatusMessageInput): string {
  const lines: string[] = [];
  lines.push(`🤖 <b>${htmlEscape(i.agentName)} online</b>`);
  lines.push('');
  lines.push(`📦 v${i.version}`);
  if (i.agentCount > 1) {
    lines.push(`👥 ${i.agentCount} agents · default: ${htmlEscape(i.defaultAgentId)}`);
  }
  lines.push(
    `🛠 ${i.skillsLoaded} ${pluralise('skill', i.skillsLoaded)} · ⏰ ${i.activeSchedules} ${pluralise('schedule', i.activeSchedules)}`,
  );
  lines.push(`🌍 Started ${formatLocalTime(i.startedAt, i.timezone)} (${i.timezone})`);
  return lines.join('\n');
}

/**
 * Format a Date as `HH:MM` in the given IANA timezone. Uses ICU
 * (already a runtime dep — node-cron + the scheduler validate
 * timezones via `Intl.DateTimeFormat` on boot).
 */
function formatLocalTime(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(d);
}

function pluralise(noun: string, n: number): string {
  return n === 1 ? noun : `${noun}s`;
}
