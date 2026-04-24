import { dim, yellow } from '../../ansi.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Boolean toggle — renders a checkbox, flips on Enter.
 *
 * Constructor takes `read` + `write` callbacks so the same component
 * class covers YAML-backed fields (memory.autoAccept,
 * dashboard.enabled, …), SQLite-backed flags (voice_state.enabled),
 * or anything else. The class is stateless; `ctx` is passed through
 * to the callbacks on every invocation.
 *
 * `canToggle` is an optional guard for "you can't enable this right
 * now" states (e.g. "no Groq key set yet"). Return a human-readable
 * reason string to refuse the flip; return `null` to allow. The
 * reason is printed to stdout and `handleSelect` returns
 * `{ changed: false }` so the runner's restart counter doesn't budge.
 */
export interface BooleanSettingOptions {
  id: string;
  label: string;
  restart: boolean;
  read: (ctx: SettingsContext) => boolean;
  write: (ctx: SettingsContext, next: boolean) => void | Promise<void>;
  canToggle?: (ctx: SettingsContext, current: boolean) => string | null;
}

export class BooleanSetting implements SettingComponent {
  readonly id: string;
  private readonly label: string;
  private readonly restart: boolean;
  private readonly read: BooleanSettingOptions['read'];
  private readonly write: BooleanSettingOptions['write'];
  private readonly canToggle: BooleanSettingOptions['canToggle'];

  constructor(opts: BooleanSettingOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.restart = opts.restart;
    this.read = opts.read;
    this.write = opts.write;
    this.canToggle = opts.canToggle;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    return {
      label: this.label,
      checked: this.read(ctx),
      restart: this.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.read(ctx);
    const disallowReason = this.canToggle?.(ctx, current);
    if (disallowReason) {
      ctx.stdout.write(`\n  ${yellow('!')} ${dim(disallowReason)}\n`);
      return { changed: false, restart: false };
    }
    await this.write(ctx, !current);
    return { changed: true, restart: this.restart };
  }
}
