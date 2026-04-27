import { describe, it, expect, vi } from 'vitest';
import { renderLayout } from '../../../src/cli/settings/renderer.js';
import type { Section } from '../../../src/cli/settings/layout.js';
import type {
  SettingComponent,
  SettingsContext,
} from '../../../src/cli/settings/types.js';

/**
 * THE ROUTING TEST.
 *
 * Settings-menu v0.13.0 shipped with an index-mismatch bug: picker
 * row indices included section-header rows, but the descriptor array
 * did not. Clicking "Model" (picker idx 3 in a 4-section layout)
 * resolved to the wrong descriptor, silently editing an unrelated
 * field.
 *
 * This test locks the invariant that prevents that bug: for every
 * picker row idx, `indexToId[idx]` is either `undefined` (header) or
 * the EXACT id declared in the layout. We construct a layout with 3
 * sections + 5 settings and assert each position.
 */

function fakeComponent(id: string, label: string): SettingComponent {
  return {
    id,
    renderRow: () => ({ label, meta: `value-of-${id}`, restart: false }),
    handleSelect: async () => ({ changed: false, restart: false }),
  };
}

function fakeCtx(): SettingsContext {
  return {
    stdin: {} as never,
    stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    configPath: '',
    envPath: '',
    voiceState: {} as never,
    readYaml: () => '',
    writeYaml: () => {},
    readEnv: () => ({}),
    writeEnv: () => {},
  };
}

describe('renderLayout — id-routing invariant', () => {
  const LAYOUT: ReadonlyArray<Section> = [
    { title: 'General', settingIds: ['gen.one'] },
    { title: 'Agent', settingIds: ['agent.model', 'agent.log', 'agent.history'] },
    { title: 'Budget', settingIds: ['budget.daily'] },
  ];
  const registry = new Map<string, SettingComponent>([
    ['gen.one', fakeComponent('gen.one', 'General one')],
    ['agent.model', fakeComponent('agent.model', 'Model')],
    ['agent.log', fakeComponent('agent.log', 'Log level')],
    ['agent.history', fakeComponent('agent.history', 'Conversation history')],
    ['budget.daily', fakeComponent('budget.daily', 'Daily budget')],
  ]);

  it('produces parallel items[] and indexToId[] of the same length', () => {
    const { items, indexToId } = renderLayout(LAYOUT, registry, fakeCtx());
    expect(items.length).toBe(indexToId.length);
  });

  it('header rows have undefined id and marker kind', () => {
    const { items, indexToId } = renderLayout(LAYOUT, registry, fakeCtx());
    const headerIndices = items
      .map((it, i) => (it.kind === 'header' ? i : -1))
      .filter((i) => i >= 0);
    // 3 sections → 3 headers
    expect(headerIndices.length).toBe(3);
    for (const i of headerIndices) {
      expect(indexToId[i]).toBeUndefined();
    }
  });

  it('regression guard: picking the row where Model is rendered dispatches to agent.model', () => {
    // Layout produces:
    //   0: header General
    //   1: gen.one
    //   2: header Agent
    //   3: agent.model   ← this is the row a user sees as "Model"
    //   4: agent.log
    //   5: agent.history
    //   6: header Budget
    //   7: budget.daily
    const { items, indexToId } = renderLayout(LAYOUT, registry, fakeCtx());
    const modelIdx = items.findIndex(
      (it) => it.kind !== 'header' && it.label === 'Model',
    );
    expect(modelIdx).toBe(3);
    expect(indexToId[modelIdx]).toBe('agent.model'); // not 'agent.history' — that was the bug
  });

  it('every non-header item maps to the id that produced it', () => {
    const { items, indexToId } = renderLayout(LAYOUT, registry, fakeCtx());
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]!;
      if (it.kind === 'header') {
        expect(indexToId[i]).toBeUndefined();
        continue;
      }
      const id = indexToId[i];
      expect(id).toBeDefined();
      const component = registry.get(id!);
      expect(component).toBeDefined();
      // Label on the picker item must match the component's renderRow
      // label — proves we didn't rearrange rows in transit.
      expect(it.label).toBe(component!.renderRow(fakeCtx()).label);
    }
  });

  it('skips settings missing from the registry without corrupting the mapping', () => {
    const layout: Section[] = [
      { title: 'Agent', settingIds: ['agent.model', 'agent.missing', 'agent.log'] },
    ];
    const { items, indexToId } = renderLayout(layout, registry, fakeCtx());
    // 1 header + 2 settings (missing one skipped)
    expect(items.length).toBe(3);
    expect(indexToId).toEqual([undefined, 'agent.model', 'agent.log']);
  });
});
