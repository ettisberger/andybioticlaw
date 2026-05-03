import { describe, it, expect } from 'vitest';
import { buildStatusMessage } from '../../src/telegram/status-message.js';

/**
 * The boot-status message is the first thing the principal sees after
 * a deploy completes. Pin the format so a trivial refactor doesn't
 * accidentally change what the operator's been trained to skim.
 *
 * Snapshots use exact-string compare (not vitest snapshots) so the
 * intent of each line is visible in the test source.
 */

const FIXED_BOOT = new Date('2026-04-30T12:23:45Z'); // 14:23 in Europe/Zurich

describe('buildStatusMessage', () => {
  it('renders the single-agent format (no agents line when count = 1)', () => {
    const text = buildStatusMessage({
      agentName: 'Emma',
      agentCount: 1,
      defaultAgentId: 'emma',
      version: '0.22.16',
      skillsLoaded: 4,
      activeSchedules: 12,
      startedAt: FIXED_BOOT,
      timezone: 'Europe/Zurich',
    });
    expect(text).toBe(
      [
        '🤖 <b>Emma online</b>',
        '',
        '📦 v0.22.16',
        '🛠 4 skills · ⏰ 12 schedules',
        '🌍 Started 14:23 (Europe/Zurich)',
      ].join('\n'),
    );
  });

  it('inserts an "agents" line when there are 2+ agents', () => {
    const text = buildStatusMessage({
      agentName: 'Emma',
      agentCount: 2,
      defaultAgentId: 'emma',
      version: '0.22.16',
      skillsLoaded: 4,
      activeSchedules: 12,
      startedAt: FIXED_BOOT,
      timezone: 'Europe/Zurich',
    });
    expect(text).toContain('👥 2 agents · default: emma');
    // And the line ordering: agents line sits between version and skills/schedules.
    const lines = text.split('\n');
    const versionIdx = lines.findIndex((l) => l.startsWith('📦'));
    const agentsIdx = lines.findIndex((l) => l.startsWith('👥'));
    const skillsIdx = lines.findIndex((l) => l.startsWith('🛠'));
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBe(versionIdx + 1);
    expect(skillsIdx).toBe(agentsIdx + 1);
  });

  it('uses singular nouns for counts of 1', () => {
    const text = buildStatusMessage({
      agentName: 'Emma',
      agentCount: 1,
      defaultAgentId: 'emma',
      version: '0.22.16',
      skillsLoaded: 1,
      activeSchedules: 1,
      startedAt: FIXED_BOOT,
      timezone: 'Europe/Zurich',
    });
    expect(text).toContain('🛠 1 skill · ⏰ 1 schedule');
  });

  it('uses plural for 0 (no schedules / no skills loaded edge case)', () => {
    const text = buildStatusMessage({
      agentName: 'Emma',
      agentCount: 1,
      defaultAgentId: 'emma',
      version: '0.22.16',
      skillsLoaded: 0,
      activeSchedules: 0,
      startedAt: FIXED_BOOT,
      timezone: 'Europe/Zurich',
    });
    expect(text).toContain('🛠 0 skills · ⏰ 0 schedules');
  });

  it('escapes HTML metacharacters in agentName + defaultAgentId', () => {
    const text = buildStatusMessage({
      agentName: 'Work & <prod>',
      agentCount: 2,
      defaultAgentId: 'a&b<c>',
      version: '0.0.0',
      skillsLoaded: 0,
      activeSchedules: 0,
      startedAt: FIXED_BOOT,
      timezone: 'Europe/Zurich',
    });
    expect(text).toContain('<b>Work &amp; &lt;prod&gt; online</b>');
    expect(text).toContain('default: a&amp;b&lt;c&gt;');
    // Raw `<prod>` must not appear inside the bold tag (would
    // trigger Telegram's parse-entities fallback).
    expect(text).not.toContain('<b>Work & <prod>');
  });

  it('renders the timezone-localised time correctly', () => {
    // 12:23 UTC = 21:23 in Asia/Tokyo (UTC+9, no DST).
    const text = buildStatusMessage({
      agentName: 'Emma',
      agentCount: 1,
      defaultAgentId: 'emma',
      version: '0.22.16',
      skillsLoaded: 1,
      activeSchedules: 1,
      startedAt: FIXED_BOOT,
      timezone: 'Asia/Tokyo',
    });
    expect(text).toContain('🌍 Started 21:23 (Asia/Tokyo)');
  });
});
