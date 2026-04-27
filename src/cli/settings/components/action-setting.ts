import { dim } from '../../ansi.js';
import { waitForKey } from '../../prompt-helpers.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Non-persistent action — Enter runs a function, no state stored.
 * Currently used for "Test transcription…" under Voice input.
 *
 * `renderMeta` returns what the right column shows (e.g. a hint about
 * preconditions). The action returns nothing meaningful; the component
 * always reports `changed: false` since there's nothing to restart for.
 */
export interface ActionSettingOptions {
  id: string;
  label: string;
  renderMeta: (ctx: SettingsContext) => string;
  action: (ctx: SettingsContext) => void | Promise<void>;
}

export class ActionSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: ActionSettingOptions;

  constructor(opts: ActionSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    return {
      label: this.opts.label,
      meta: this.opts.renderMeta(ctx),
      restart: false,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    await this.opts.action(ctx);
    // The settings menu redraws (and clears the screen above) on the
    // very next loop iteration, so anything the action printed would
    // scroll away before the operator could read it. Pause here on a
    // single keypress so output (e.g. an Agents/Policies dump) stays
    // visible until the operator chooses to dismiss it.
    ctx.stdout.write(`\n  ${dim('press any key to continue…')}\n`);
    await waitForKey(ctx.stdin);
    return { changed: false, restart: false };
  }
}
