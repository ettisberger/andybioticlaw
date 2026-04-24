import { patchYaml } from '../yaml.js';
import { promptEnum } from '../prompts.js';
import type { EnumOption } from '../prompts.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Enum (one of a fixed set of string values) — e.g. agent.model,
 * service.logLevel.
 *
 * `read` returns the current value; `patchRegex` targets the YAML
 * line; `options` is the allowed set. Rendering shows the current
 * value in the meta column; Enter opens a sub-picker.
 *
 * A separate `promptEnum` from `settings/prompts.ts` does the actual
 * sub-picker interaction so this class stays tiny + testable.
 */
export interface EnumSettingOptions {
  id: string;
  label: string;
  pathLabel: string;
  restart: boolean;
  read: (ctx: SettingsContext) => string;
  patchRegex: RegExp;
  options: ReadonlyArray<EnumOption>;
  /** Optional async prompter override — for tests. Defaults to `promptEnum`. */
  prompter?: typeof promptEnum;
}

export class EnumSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: EnumSettingOptions;

  constructor(opts: EnumSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    return {
      label: this.opts.label,
      meta: this.opts.read(ctx),
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.opts.read(ctx);
    const prompter = this.opts.prompter ?? promptEnum;
    const outcome = await prompter(ctx, this.opts.pathLabel, current, this.opts.options);
    if (!outcome.changed || outcome.next === undefined) {
      return { changed: false, restart: false };
    }
    const result = patchYaml(
      ctx,
      this.opts.patchRegex,
      `$1${outcome.next}`,
      this.opts.pathLabel,
      current,
      outcome.next,
      this.opts.restart,
    );
    return {
      changed: result.patched && result.validationOk,
      restart: this.opts.restart,
    };
  }
}
