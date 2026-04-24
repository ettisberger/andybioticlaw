import { green, yellow } from '../ansi.js';
import type { PickerItem } from '../prompt-helpers.js';
import type { Section } from './layout.js';
import type { SettingComponent, SettingsContext } from './types.js';

export interface RenderedLayout {
  /** Row list ready to hand to arrowPicker. */
  items: PickerItem[];
  /**
   * Parallel array to `items`: `indexToId[i]` is the setting id for
   * picker row `i`, or `undefined` if row `i` is a section header.
   *
   * This is the routing invariant — never address settings by picker
   * array index; always go through `indexToId[idx]` → registry lookup.
   */
  indexToId: Array<string | undefined>;
}

/**
 * Walk the layout, render each setting's row, emit header rows
 * between sections. The items + indexToId arrays are produced in the
 * same pass so they MUST stay in sync by construction.
 */
export function renderLayout(
  layout: ReadonlyArray<Section>,
  registry: Map<string, SettingComponent>,
  ctx: SettingsContext,
): RenderedLayout {
  const items: PickerItem[] = [];
  const indexToId: Array<string | undefined> = [];

  for (const section of layout) {
    // Section header — non-selectable row rendered dimly above its settings.
    items.push({ kind: 'header', label: section.title });
    indexToId.push(undefined);

    for (const settingId of section.settingIds) {
      const component = registry.get(settingId);
      if (!component) continue;
      const row = component.renderRow(ctx);
      const tag = row.restart ? yellow('restart') : green('live');
      const pickerItem: PickerItem = {
        label: row.label,
        tag,
      };
      if (row.checked !== undefined) {
        pickerItem.checked = row.checked;
      }
      if (row.meta !== undefined) {
        pickerItem.meta = row.meta;
      }
      items.push(pickerItem);
      indexToId.push(settingId);
    }
  }

  return { items, indexToId };
}
