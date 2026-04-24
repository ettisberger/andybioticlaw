import { arrowPicker } from '../../prompt-helpers.js';
import { announceSaved, hashArgon2, promptSecret } from '../prompts.js';
import { patchYaml } from '../yaml.js';
import { dim } from '../../ansi.js';
import type {
  SettingComponent,
  SettingRow,
  SettingSelectResult,
  SettingsContext,
} from '../types.js';

/**
 * Secret-valued setting: Groq API key, dashboard password hash, …
 *
 * Rendering: `first6••••last4` when set, `not set` when empty.
 * Enter opens a small sub-picker: Set/Update · Remove · Cancel. This
 * avoids a destructive "set new key" flow when the operator only
 * wanted to browse the rows.
 *
 * Storage: we support two paths via `storage`:
 *   - `{ kind: 'env', key: 'GROQ_API_KEY' }` → writeEnv / readEnv
 *   - `{ kind: 'yaml', regex, pathLabel }` → patchYaml with a hashed
 *     replacement (argon2id for the dashboard password; configurable
 *     via `transform`)
 *
 * Optional `onRemove(ctx)` runs after the key is cleared. Used by the
 * voice setup to also flip `voice_state.enabled = false` when the
 * Groq key is removed — otherwise voice would stay on with no key and
 * every voice message would bounce.
 */
export type SecretStorage =
  | { kind: 'env'; key: string }
  | { kind: 'yaml'; regex: RegExp; pathLabel: string; quoteValue: boolean };

export interface SecretSettingOptions {
  id: string;
  label: string;
  restart: boolean;
  storage: SecretStorage;
  /** Transform the user-typed value before persistence. Defaults to identity. */
  transform?: (input: string) => string | Promise<string>;
  /** Invoked after a successful remove. Use for side effects (e.g. disable voice). */
  onRemove?: (ctx: SettingsContext) => void | Promise<void>;
  /** Override the sub-picker for tests. */
  picker?: typeof arrowPicker;
  /** Override the secret prompt for tests. */
  secretPrompt?: typeof promptSecret;
}

export class SecretSetting implements SettingComponent {
  readonly id: string;
  private readonly opts: SecretSettingOptions;

  constructor(opts: SecretSettingOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  private currentRaw(ctx: SettingsContext): string {
    if (this.opts.storage.kind === 'env') {
      return (ctx.readEnv()[this.opts.storage.key] ?? '').trim();
    }
    // YAML-hash storage: we can tell "set" vs "not set" but never see
    // the plaintext. Treat any matching non-empty line as "set".
    const body = ctx.readYaml();
    const m = body.match(this.opts.storage.regex);
    return m && m[1] ? m[1] : '';
  }

  renderRow(ctx: SettingsContext): SettingRow {
    const raw = this.currentRaw(ctx);
    const meta = raw ? maskSecret(raw) : 'not set';
    return {
      label: this.opts.label,
      meta,
      restart: this.opts.restart,
    };
  }

  async handleSelect(ctx: SettingsContext): Promise<SettingSelectResult> {
    const pickerImpl = this.opts.picker ?? arrowPicker;
    const secretPrompter = this.opts.secretPrompt ?? promptSecret;
    const hasKey = this.currentRaw(ctx) !== '';

    const actionItems: Array<{ label: string }> = [
      { label: hasKey ? 'Update' : 'Set' },
      ...(hasKey ? [{ label: 'Remove' }] : []),
      { label: 'Cancel' },
    ];
    const actionIdx = await pickerImpl(ctx.stdin, ctx.stdout, {
      title: this.opts.label,
      helpLine: '↑/↓ move · Enter select · q cancel',
      items: actionItems,
    });
    if (actionIdx < 0) return { changed: false, restart: false };
    if (hasKey && actionIdx === 1) {
      await this.remove(ctx);
      announceSaved(ctx, `${this.opts.label} cleared.`);
      return { changed: true, restart: this.opts.restart };
    }
    if (actionIdx === actionItems.length - 1) {
      return { changed: false, restart: false };
    }

    const outcome = await secretPrompter(ctx, this.opts.label);
    if (!outcome.changed || outcome.next === undefined) {
      return { changed: false, restart: false };
    }
    const transformed = this.opts.transform
      ? await this.opts.transform(outcome.next)
      : outcome.next;
    await this.write(ctx, transformed);
    announceSaved(
      ctx,
      `${this.opts.label} saved${this.opts.restart ? ' (restart to apply)' : ''}.`,
    );
    return { changed: true, restart: this.opts.restart };
  }

  private async write(ctx: SettingsContext, value: string): Promise<void> {
    if (this.opts.storage.kind === 'env') {
      ctx.writeEnv({ [this.opts.storage.key]: value });
      return;
    }
    const replacement = this.opts.storage.quoteValue
      ? `$1'${value}'`
      : `$1${value}`;
    patchYaml(
      ctx,
      this.opts.storage.regex,
      replacement,
      this.opts.storage.pathLabel,
      dim('old value'),
      dim('new value'),
      this.opts.restart,
    );
  }

  private async remove(ctx: SettingsContext): Promise<void> {
    if (this.opts.storage.kind === 'env') {
      ctx.writeEnv({ [this.opts.storage.key]: '' });
    } else {
      patchYaml(
        ctx,
        this.opts.storage.regex,
        `$1''`,
        this.opts.storage.pathLabel,
        dim('old value'),
        dim('empty'),
        this.opts.restart,
      );
    }
    if (this.opts.onRemove) await this.opts.onRemove(ctx);
  }
}

export { hashArgon2 };

function maskSecret(raw: string): string {
  if (raw.length <= 12) return '•••••• (set)';
  return `${raw.slice(0, 6)}${'•'.repeat(6)}${raw.slice(-4)}`;
}
