import type { VoiceStateRepo } from '../../db/repositories/voice-state.js';

/**
 * Contract every Settings component implements.
 *
 * A component is responsible for rendering ONE row (label + current
 * value or checkbox + metadata + restart-tag) and handling Enter on
 * that row (open an editor, flip a boolean, run an action, …).
 *
 * The runner (src/cli/settings/run.ts) routes selections by `id` via
 * a registry Map, never by array index — that's the invariant that
 * prevents the index-mismatch class of bug (headers offsetting the
 * row count vs descriptor count).
 */
export interface SettingComponent {
  readonly id: string;
  renderRow(ctx: SettingsContext): SettingRow;
  handleSelect(ctx: SettingsContext): Promise<SettingSelectResult>;
}

/**
 * Environment passed to every component on render + select. Owns fs
 * and db access so components don't go stateful or accidentally read
 * stale values. Every `read*` helper returns a fresh view each time —
 * safe to call once per render frame; never cache across frames.
 */
export interface SettingsContext {
  stdin: Stdin;
  stdout: NodeJS.WritableStream;
  /** Absolute path to the YAML config file. */
  configPath: string;
  /** Absolute path to `.env`. */
  envPath: string;
  /** SQLite-backed voice-input toggle. */
  voiceState: VoiceStateRepo;

  // --- per-frame read/write facade ------------------------------------
  readYaml(): string;
  writeYaml(body: string): void;
  readEnv(): Record<string, string>;
  writeEnv(updates: Record<string, string>): void;
}

export type Stdin = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
};

/**
 * What a component's `renderRow` returns. The picker layer turns this
 * into a PickerItem (with ANSI colouring, padding, etc.).
 *
 * `checked !== undefined` means this row is a boolean toggle and
 * renders with a checkbox; otherwise it's a value row with `meta`
 * shown in the right column.
 */
export interface SettingRow {
  label: string;
  /** Visible right-column content for value rows (e.g. `"50 msgs"`). Ignored for boolean rows. */
  meta?: string;
  /** If defined, the row is a boolean toggle. Checkbox renders filled or empty. */
  checked?: boolean;
  /** Whether changing this setting requires `systemctl restart` to take effect. */
  restart: boolean;
}

export interface SettingSelectResult {
  /** True iff state was actually mutated (vs. aborted, unchanged, refused). */
  changed: boolean;
  /** True iff the mutation requires a restart to take effect. */
  restart: boolean;
}
