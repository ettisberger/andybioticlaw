import { describe, it, expect } from 'vitest';
import {
  createLiveSessionsTracker,
  MAX_TEXT_CHARS,
} from '../../src/observability/live-sessions.js';

describe('LiveSessionsTracker', () => {
  it('captures start, deltas, tool uses, and end', () => {
    const t = createLiveSessionsTracker();
    t.start({ sessionId: 'a', chatId: '42', source: 'dm' });
    t.onDelta('a', 'hello ');
    t.onDelta('a', 'there');
    t.onToolUse('a', 'mcp__google-calendar__list_events');
    t.onToolUse('a', 'mcp__google-calendar__list_events');

    const snap = t.snapshotOne('a');
    expect(snap).not.toBeNull();
    expect(snap!.text).toBe('hello there');
    expect(snap!.toolUses).toEqual([
      'mcp__google-calendar__list_events',
      'mcp__google-calendar__list_events',
    ]);
    expect(snap!.source).toBe('dm');
    expect(snap!.lastDeltaAt).not.toBeNull();
    expect(snap!.truncated).toBe(false);

    t.end('a');
    expect(t.snapshotOne('a')).toBeNull();
    expect(t.snapshot()).toEqual([]);
  });

  it('silently ignores deltas / tool uses for unknown session ids', () => {
    const t = createLiveSessionsTracker();
    // No start() — these should be no-ops, never throw.
    t.onDelta('nope', 'x');
    t.onToolUse('nope', 'x');
    t.end('nope');
    expect(t.snapshot()).toEqual([]);
  });

  it('truncates text that exceeds MAX_TEXT_CHARS with a leading ellipsis marker', () => {
    const t = createLiveSessionsTracker();
    t.start({ sessionId: 's', chatId: '1', source: 'dm' });
    // Push ~2× the cap in small chunks so we also exercise the incremental
    // truncation path (not just one giant append).
    const chunk = 'x'.repeat(1024);
    for (let i = 0; i < Math.ceil((MAX_TEXT_CHARS * 2) / chunk.length); i += 1) {
      t.onDelta('s', chunk);
    }
    const snap = t.snapshotOne('s');
    expect(snap!.truncated).toBe(true);
    expect(snap!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(snap!.text.startsWith('…')).toBe(true);
  });

  it('snapshots are independent copies — mutating caller data does not leak', () => {
    const t = createLiveSessionsTracker();
    t.start({ sessionId: 'a', chatId: '1', source: 'dm' });
    t.onToolUse('a', 'one');
    const s1 = t.snapshotOne('a')!;
    s1.toolUses.push('mutated!');
    const s2 = t.snapshotOne('a')!;
    expect(s2.toolUses).toEqual(['one']);
  });

  it('snapshot() returns all concurrently running sessions', () => {
    const t = createLiveSessionsTracker();
    t.start({ sessionId: 'a', chatId: '1', source: 'dm' });
    t.start({ sessionId: 'b', chatId: '2', source: 'schedule' });
    expect(t.snapshot().map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });
});
