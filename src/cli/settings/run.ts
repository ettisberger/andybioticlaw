import pino from 'pino';
import { cyan, dim, yellow } from '../ansi.js';
import { arrowPicker, releaseStdin } from '../prompt-helpers.js';
import { loadConfig, projectRoot } from '../../config/load.js';
import { defaultConfigPath, defaultEnvPath, expandPath, sqliteDbPath } from '../../config/paths.js';
import { openDatabase } from '../../db/index.js';
import { createVoiceStateRepo } from '../../db/repositories/voice-state.js';
import { existsSync } from 'node:fs';
import { createSettingsContext } from './context.js';
import { SETTINGS_LAYOUT } from './layout.js';
import { buildSettingsRegistry } from './registry.js';
import { renderLayout } from './renderer.js';
import type { SettingComponent, SettingsContext } from './types.js';

/**
 * Main entrypoint for the Settings menu. Boots the SettingsContext,
 * builds the registry, loops the picker until q/Ctrl-C.
 *
 * Routing goes through `indexToId[idx] → registry.get(id)` — never
 * picker-index-based indexing into a descriptor array. That's the
 * invariant the renderer.test.ts guards.
 */
export async function runSettingsCommand(): Promise<void> {
  const stdout = process.stdout;
  const configPath = defaultConfigPath(projectRoot());

  if (!existsSync(configPath)) {
    stdout.write(
      `\n  ${yellow('!')} ${dim(`config not found at ${configPath} — run 'andybioticlaw init' first.`)}\n\n`,
    );
    return;
  }

  // Open SQLite just for the voice_state toggle; close on return so the
  // TUI exits cleanly. We also pick up dataDir from the validated config
  // rather than defaulting — respects operator overrides.
  const loaded = loadConfig();
  const dataDir = expandPath(loaded.config.service.dataDir, projectRoot());
  const logger = pino({ level: 'warn' });
  const dbHandle = openDatabase(sqliteDbPath(dataDir), logger);

  try {
    const voiceState = createVoiceStateRepo(dbHandle.db);
    const ctx = createSettingsContext({
      stdin: process.stdin,
      stdout,
      configPath,
      envPath: defaultEnvPath(projectRoot()),
      voiceState,
    });
    const registry = buildSettingsRegistry();

    await runSettingsLoop(ctx, registry);
  } finally {
    dbHandle.close();
    releaseStdin();
  }
}

/**
 * Pure-ish settings loop — takes an already-constructed ctx and
 * registry. Exported so tests can drive it against tmpfs + a fake
 * stdin. The only I/O it does is through ctx + arrowPicker.
 */
export async function runSettingsLoop(
  ctx: SettingsContext,
  registry: Map<string, SettingComponent>,
): Promise<void> {
  let restartPending = 0;
  const markRestart = (r: boolean): void => {
    if (r) restartPending += 1;
  };

  while (true) {
    // Thunks both items + footer so arrowPicker's internal redraw
    // after each toggle picks up fresh state (values, checked-flags,
    // and the pending-count banner).
    const itemsThunk = () => renderLayout(SETTINGS_LAYOUT, registry, ctx).items;
    const footerThunk = (): string | undefined =>
      restartPending > 0
        ? yellow(
            `⚠ restart required — ${restartPending} change${
              restartPending === 1 ? '' : 's'
            } pending — ${cyan('sudo systemctl restart andybioticlaw')}`,
          )
        : undefined;

    const idx = await arrowPicker(ctx.stdin, ctx.stdout, {
      title: 'Settings',
      helpLine: '↑/↓ move · Enter toggle or edit · q back',
      items: itemsThunk,
      footer: footerThunk,
      onToggle: async (i) => {
        // Look up the setting id via the SAME layout→render we just
        // drew. No array-index slicing between snapshots.
        const snapshot = renderLayout(SETTINGS_LAYOUT, registry, ctx);
        const id = snapshot.indexToId[i];
        if (!id) return;
        const component = registry.get(id);
        if (!component) return;
        const result = await component.handleSelect(ctx);
        if (result.changed) markRestart(result.restart);
      },
    });

    if (idx < 0) return;

    // Non-toggle select — same id-routing path.
    const snapshot = renderLayout(SETTINGS_LAYOUT, registry, ctx);
    const id = snapshot.indexToId[idx];
    if (!id) continue; // header — shouldn't happen (arrow nav skips), be defensive
    const component = registry.get(id);
    if (!component) continue;
    try {
      const result = await component.handleSelect(ctx);
      if (result.changed) markRestart(result.restart);
    } catch (e) {
      ctx.stdout.write(`\n  ${yellow('!')} ${dim((e as Error).message)}\n`);
    }
  }
}
