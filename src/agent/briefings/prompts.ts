/**
 * Hardcoded prompts for the morning + evening briefings.
 *
 * These are shipped as constants (not config) so the operator can't
 * accidentally break the graceful-degradation shape of Emma's reply.
 * Tone/format rules are applied on top of the system prompt via the
 * existing Presentation rules in `system.base.md`.
 *
 * Keys likely to drift when the skill set changes:
 *   - `mcp__google-calendar__list_events` — the calendar skill's tool
 *     name. If you rename/replace the skill, update here too.
 *   - `himalaya` — email skill name referenced in the prompt's "if
 *     installed" hint.
 */

export const MORNING_BRIEFING_PROMPT = `Your principal just started the day. Give them a compact morning briefing.

Gather (call tools as needed, skip sections where the skill isn't available):

1. Today's calendar events in their local timezone via
   mcp__google-calendar__list_events (timeMin=start-of-today,
   timeMax=end-of-today). Format each with ⏰ start time and 📍 location
   if present.
2. Any high-priority unread emails if the himalaya skill is active.
3. Pending reminders (from the scheduler) due in the next 24h.

Respond in Telegram HTML. Keep it under ~300 words. Use the emoji/layout
guidance from your system prompt — 📅 for dates, ⏰ for times, 📍 for
locations, ☀️ for the opening line.

If there is nothing notable, reply briefly (one or two sentences —
e.g. "🌤 Clear day — nothing on your calendar, no urgent email.")
rather than padding.

Do NOT ask clarifying questions. Do NOT use the memory tool. Do NOT
wait for the principal to reply — your reply IS the briefing.`;

export const EVENING_BRIEFING_PROMPT = `Your principal is winding down for the day. Give them a compact evening briefing.

Gather (call tools as needed, skip sections where the skill isn't available):

1. A recap of what you did with them today — pull recent session
   summaries if available, otherwise name the top 2–3 topics from
   today's conversation.
2. Tomorrow's top calendar items via mcp__google-calendar__list_events
   (timeMin=start-of-tomorrow, timeMax=end-of-tomorrow).
3. Any reminders scheduled to fire in the next 24h.
4. Anything outstanding worth surfacing (unanswered email if himalaya
   is active, deferred tasks, etc.).

Respond in Telegram HTML. Keep it under ~300 words. Use 🌙 for the
opening line, ⏰ / 📍 for tomorrow's items.

If the day was quiet, a two-sentence "🌙 Quiet day. Nothing on the
calendar tomorrow." is fine — don't pad.

Do NOT ask clarifying questions. Do NOT use the memory tool. Your
reply IS the briefing.`;
