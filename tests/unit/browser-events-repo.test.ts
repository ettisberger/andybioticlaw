import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import {
  createBrowserEventsRepo,
  type BrowserEventsRepo,
} from '../../src/db/repositories/browser-events.js';

const SILENT = pino({ level: 'silent' });

describe('BrowserEventsRepo', () => {
  let dir: string;
  let handle: ReturnType<typeof openDatabase>;
  let repo: BrowserEventsRepo;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-be-'));
    handle = openDatabase(resolve(dir, 'test.db'), SILENT);
    repo = createBrowserEventsRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insert(args: {
    sessionId: string;
    profile: string;
    action: string;
    outcome?: string;
    createdAtMs?: number;
    targetUrl?: string;
    screenshotPath?: string;
  }) {
    handle.db
      .prepare(
        `INSERT INTO browser_events (session_id, profile, action, target_url, ref_or_selector, outcome, error_message, screenshot_path, created_at_ms)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        args.sessionId,
        args.profile,
        args.action,
        args.targetUrl ?? null,
        args.outcome ?? 'ok',
        args.screenshotPath ?? null,
        args.createdAtMs ?? Date.now(),
      );
  }

  it('listSessions aggregates by session_id with newest first', () => {
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_navigate', createdAtMs: 1000 });
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_click', createdAtMs: 2000 });
    insert({ sessionId: 'B', profile: 'gh', action: 'browser_navigate', createdAtMs: 3000 });
    const sessions = repo.listSessions(10);
    expect(sessions[0]!.sessionId).toBe('B');
    expect(sessions[1]!.sessionId).toBe('A');
    expect(sessions[1]!.eventCount).toBe(2);
    expect(sessions[1]!.profiles).toEqual(['gmail']);
    expect(sessions[1]!.firstEventMs).toBe(1000);
    expect(sessions[1]!.lastEventMs).toBe(2000);
  });

  it('listSessions tracks ok vs error counts', () => {
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_navigate', outcome: 'ok' });
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_click', outcome: 'error' });
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_click', outcome: 'blocked' });
    const [s] = repo.listSessions(10);
    expect(s!.okCount).toBe(1);
    expect(s!.errorCount).toBe(2);
  });

  it('listSessions deduplicates profiles per session', () => {
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_navigate' });
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_click' });
    insert({ sessionId: 'A', profile: 'github', action: 'browser_navigate' });
    const [s] = repo.listSessions(10);
    expect(new Set(s!.profiles)).toEqual(new Set(['gmail', 'github']));
  });

  it('listForSession returns oldest-first events for the session', () => {
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_click', createdAtMs: 2000 });
    insert({ sessionId: 'A', profile: 'gmail', action: 'browser_navigate', createdAtMs: 1000 });
    insert({ sessionId: 'B', profile: 'gh', action: 'browser_navigate', createdAtMs: 1500 });
    const events = repo.listForSession('A');
    expect(events.map((e) => e.action)).toEqual(['browser_navigate', 'browser_click']);
  });

  it('deleteOlderThan prunes only matching rows', () => {
    insert({ sessionId: 'old', profile: 'x', action: 'browser_navigate', createdAtMs: 100 });
    insert({ sessionId: 'new', profile: 'x', action: 'browser_navigate', createdAtMs: 9999 });
    const removed = repo.deleteOlderThan(1000);
    expect(removed).toBe(1);
    expect(repo.listForSession('old')).toHaveLength(0);
    expect(repo.listForSession('new')).toHaveLength(1);
  });

  it('listScreenshotPaths returns only rows with a path, oldest first', () => {
    insert({ sessionId: 'A', profile: 'x', action: 'browser_navigate', createdAtMs: 2000, screenshotPath: '/tmp/b.png' });
    insert({ sessionId: 'A', profile: 'x', action: 'browser_navigate', createdAtMs: 1000, screenshotPath: '/tmp/a.png' });
    insert({ sessionId: 'A', profile: 'x', action: 'browser_snapshot', createdAtMs: 500 });
    const paths = repo.listScreenshotPaths();
    expect(paths.map((p) => p.path)).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });
});
