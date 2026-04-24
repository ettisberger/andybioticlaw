import { cyan, dim, lavender, yellow } from '../../ansi.js';
import { askLine } from '../../prompt-helpers.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Time-of-day (HH:MM, 24h) setting. Used by the briefings rows to let
 * the operator pick a daily fire time. Storage shape is decided by the
 * caller — it just hands in `read` + `write` callbacks like
 * BooleanSetting does.
 */
export interface TimeSettingOptions {
  id: string;
  label: string;
  restart: boolean;
  read: (ctx: SettingsContext) => string;
  write: (ctx: SettingsContext, next: string) => void | Promise<void>;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class TimeSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: TimeSettingOptions;

  constructor(opts: TimeSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    const cur = this.opts.read(ctx);
    return {
      label: this.opts.label,
      meta: `⏰ ${cur}`,
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.opts.read(ctx);
    ctx.stdout.write(`\n  ${dim('current:')} ${cyan(current)}\n\n`);
    while (true) {
      const raw = await askLine(
        ctx.stdin,
        ctx.stdout,
        `  ${lavender('?')} new time HH:MM (Enter = keep)${dim(':')} `,
      );
      if (raw === null) return { changed: false, restart: false };
      const trimmed = raw.trim();
      if (trimmed === '') return { changed: false, restart: false };
      if (!TIME_RE.test(trimmed)) {
        ctx.stdout.write(
          `  ${yellow('!')} ${dim('use HH:MM in 24h format (e.g. 07:30)')}\n`,
        );
        continue;
      }
      if (trimmed === current) return { changed: false, restart: false };
      await this.opts.write(ctx, trimmed);
      return { changed: true, restart: this.opts.restart };
    }
  }
}
