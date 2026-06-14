import { describe, it, expect } from 'vitest';
import {
  ProfileLockBusyError,
  ProfileLockManager,
} from '../../skills/browser/mcp-server/src/lock.js';

describe('ProfileLockManager', () => {
  it('acquires a free profile', () => {
    const m = new ProfileLockManager();
    expect(() => m.acquire('gmail', 'sess-1', 'browser_navigate')).not.toThrow();
    expect(m.status()).toHaveLength(1);
  });

  it('blocks a second session with a clear error', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    let caught: unknown;
    try {
      m.acquire('gmail', 'sess-2', 'browser_click');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProfileLockBusyError);
    expect((caught as Error).message).toContain('sess-1');
    expect((caught as Error).message).toContain('browser_navigate');
  });

  it('allows the same session to re-acquire (nested calls)', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    expect(() => m.acquire('gmail', 'sess-1', 'browser_snapshot')).not.toThrow();
    // The tool name updates to the latest.
    expect(m.status()[0]!.tool).toBe('browser_snapshot');
  });

  it('release frees the lock', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    m.release('gmail', 'sess-1');
    expect(m.status()).toHaveLength(0);
    // Now sess-2 can take it.
    expect(() => m.acquire('gmail', 'sess-2', 'browser_navigate')).not.toThrow();
  });

  it('release is no-op when called by a different session', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    m.release('gmail', 'sess-2'); // wrong session
    expect(m.status()).toHaveLength(1); // still held by sess-1
  });

  it('releaseAll clears everything', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    m.acquire('github', 'sess-2', 'browser_navigate');
    m.releaseAll();
    expect(m.status()).toHaveLength(0);
  });

  it('different profiles do not collide', () => {
    const m = new ProfileLockManager();
    m.acquire('gmail', 'sess-1', 'browser_navigate');
    expect(() => m.acquire('github', 'sess-1', 'browser_navigate')).not.toThrow();
    expect(m.status()).toHaveLength(2);
  });
});
