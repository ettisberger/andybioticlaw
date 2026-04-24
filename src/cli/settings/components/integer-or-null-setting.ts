import { patchYaml } from '../yaml.js';
import { promptIntegerOrNull } from '../prompts.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Integer-or-null YAML setting. Used for fields that have a meaningful
 * "forever / never / disabled" absence, notably `messages.retentionDays`.
 *
 * When the current value is `null`, the meta column renders
 * `nullLabel` (default `'forever'`). The prompt accepts `null` /
 * `none` or a positive integer.
 */
export interface IntegerOrNullSettingOptions {
  id: string;
  label: string;
  pathLabel: string;
  restart: boolean;
  read: (ctx: SettingsContext) => number | null;
  patchRegex: RegExp;
  bounds?: { min?: number; max?: number };
  /** Label when the value is `null`. Default: `'forever'`. */
  nullLabel?: string;
  /** Format for non-null values. Default: `n => `${n} days``. */
  formatNumber?: (value: number) => string;
  prompter?: typeof promptIntegerOrNull;
}

export class IntegerOrNullSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: IntegerOrNullSettingOptions;

  constructor(opts: IntegerOrNullSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    const cur = this.opts.read(ctx);
    const meta =
      cur === null
        ? this.opts.nullLabel ?? 'forever'
        : this.opts.formatNumber
          ? this.opts.formatNumber(cur)
          : `${cur} days`;
    return {
      label: this.opts.label,
      meta,
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.opts.read(ctx);
    const prompter = this.opts.prompter ?? promptIntegerOrNull;
    const outcome = await prompter(ctx, current, this.opts.bounds ?? {});
    if (!outcome.changed || outcome.next === undefined) {
      return { changed: false, restart: false };
    }
    const next = outcome.next;
    const replacement = `$1${next === null ? 'null' : next}`;
    const curStr = current === null ? 'null' : `${current}`;
    const nextStr = next === null ? 'null' : `${next}`;
    const result = patchYaml(
      ctx,
      this.opts.patchRegex,
      replacement,
      this.opts.pathLabel,
      curStr,
      nextStr,
      this.opts.restart,
    );
    return {
      changed: result.patched && result.validationOk,
      restart: this.opts.restart,
    };
  }
}
