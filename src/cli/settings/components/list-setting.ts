import { patchYaml } from '../yaml.js';
import { promptIntegerList } from '../prompts.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Integer-list YAML setting. Currently used for
 * `telegram.dm.allowedUserIds` — could cover other small numeric
 * lists in the future (allowedGroupIds, etc.).
 *
 * Meta column shows `N: id1, id2, …` or the empty-list notice.
 * Enter opens a sub-menu (Add / Remove / Save).
 */
export interface ListSettingOptions {
  id: string;
  label: string;
  pathLabel: string;
  restart: boolean;
  read: (ctx: SettingsContext) => number[];
  patchRegex: RegExp;
  /** Label when the list is empty. */
  emptyLabel?: string;
  prompter?: typeof promptIntegerList;
}

export class ListSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: ListSettingOptions;

  constructor(opts: ListSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  renderRow(ctx: SettingsContext): SettingRow {
    const cur = this.opts.read(ctx);
    const meta =
      cur.length === 0
        ? this.opts.emptyLabel ?? '(none)'
        : `${cur.length}: ${cur.join(', ')}`;
    return {
      label: this.opts.label,
      meta,
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const current = this.opts.read(ctx);
    const prompter = this.opts.prompter ?? promptIntegerList;
    const outcome = await prompter(ctx, current, this.opts.label);
    if (!outcome.changed || outcome.next === undefined) {
      return { changed: false, restart: false };
    }
    const next = outcome.next;
    const result = patchYaml(
      ctx,
      this.opts.patchRegex,
      `$1[${next.join(', ')}]`,
      this.opts.pathLabel,
      current.length === 0 ? '[]' : `[${current.join(', ')}]`,
      next.length === 0 ? '[]' : `[${next.join(', ')}]`,
      this.opts.restart,
    );
    return {
      changed: result.patched && result.validationOk,
      restart: this.opts.restart,
    };
  }
}
