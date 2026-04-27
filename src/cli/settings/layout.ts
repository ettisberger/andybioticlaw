/**
 * Ordered section layout for the Settings menu. Separated from the
 * registry so layout decisions (which section each setting belongs
 * in, ordering within a section) don't force a component rewrite.
 *
 * Voice input lives under "Telegram" by design — it's a DM input
 * mode, not a separate surface.
 */
export interface Section {
  title: string;
  /** Setting ids in the order they should appear within this section. */
  settingIds: string[];
}

export const SETTINGS_LAYOUT: ReadonlyArray<Section> = [
  {
    title: 'General',
    settingIds: ['memory.autoAccept'],
  },
  {
    title: 'Agent',
    settingIds: [
      'agent.model',
      'service.logLevel',
      'telegram.conversationHistoryLimit',
      'agent.routing.enabled',
      'agent.haikuModel',
      'agent.routing.minCharsForOpus',
    ],
  },
  {
    title: 'Budget',
    settingIds: [
      'budget.dailyTokenLimit',
      'budget.perSessionTokenLimit',
      'messages.retentionDays',
    ],
  },
  {
    title: 'Telegram',
    settingIds: [
      'telegram.allowedUserIds',
      'voice.enabled',
      'voice.groqKey',
      'voice.test',
    ],
  },
  {
    title: 'Dashboard',
    settingIds: [
      'dashboard.enabled',
      'dashboard.basicAuth.enabled',
      'dashboard.basicAuth.passwordHash',
    ],
  },
  {
    title: 'Advanced',
    settingIds: ['agents.show', 'policies.show'],
  },
];
