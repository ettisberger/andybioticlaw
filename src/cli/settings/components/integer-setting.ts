import { patchYaml } from '../yaml.js';
import { promptInteger } from '../prompts.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Integer-valued YAML setting. Covers budget caps, conversation
 * history, etc.
 *
 * `format` is optional and controls how the current value renders in
 * the meta column. Default is `value.toLocaleString()` (adds thousand
 * separators — nice for token counts).
 */
export interface IntegerSettingOptions {
  id: string;
  label: string;
  pathLabel: string;
  restart: boolean;
  read: (ctx: SettingsContext) => number;
  patchRegex: RegExp;
  bounds?: { min?: number; max?: number };
  format?: (value: number) => string;
  prompter?: typeof promptInteger;
}

export class IntegerSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: IntegerSettingOptions;

  constructor(opts: IntegerSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    const cur = this.opts.read(ctx);
    const formatted = this.opts.format ? this.opts.format(cur) : cur.toLocaleString();
    return {
      label: this.opts.label,
      meta: formatted,
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.opts.read(ctx);
    const prompter = this.opts.prompter ?? promptInteger;
    const outcome = await prompter(ctx, current, this.opts.bounds ?? {});
    if (!outcome.changed || outcome.next === undefined) {
      return { changed: false, restart: false };
    }
    const result = patchYaml(
      ctx,
      this.opts.patchRegex,
      `$1${outcome.next}`,
      this.opts.pathLabel,
      current.toLocaleString(),
      outcome.next.toLocaleString(),
      this.opts.restart,
    );
    return {
      changed: result.patched && result.validationOk,
      restart: this.opts.restart,
    };
  }
}
