import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import {
  createBrowserImportRepo,
  type BrowserImportRepo,
} from '../../src/db/repositories/browser-import.js';

const SILENT = pino({ level: 'silent' });

describe('BrowserImportRepo', () => {
  let dir: string;
  let handle: ReturnType<typeof openDatabase>;
  let repo: BrowserImportRepo;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-bi-'));
    handle = openDatabase(resolve(dir, 'test.db'), SILENT);
    repo = createBrowserImportRepo(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a window and findOpen returns it', () => {
    const w = repo.open('gmail', 5 * 60 * 1000);
    expect(w.profile).toBe('gmail');
    expect(w.expiresAtMs).toBeGreaterThan(Date.now());
    const found = repo.findOpen('gmail', Date.now());
    expect(found).not.toBeNull();
    expect(found!.profile).toBe('gmail');
  });

  it('findOpen returns null for an unknown profile', () => {
    expect(repo.findOpen('unknown', Date.now())).toBeNull();
  });

  it('findOpen returns null when expired', () => {
    repo.open('gmail', 1); // 1ms ttl
    const future = Date.now() + 10_000;
    expect(repo.findOpen('gmail', future)).toBeNull();
  });

  it('findOpen returns null after consume', () => {
    repo.open('gmail', 5 * 60 * 1000);
    repo.consume('gmail', 'abc123', Date.now());
    expect(repo.findOpen('gmail', Date.now())).toBeNull();
  });

  it('re-opening the same profile resets consumed + expires fields', () => {
    repo.open('gmail', 1000);
    repo.consume('gmail', 'x', Date.now());
    expect(repo.findOpen('gmail', Date.now())).toBeNull();
    const w2 = repo.open('gmail', 60_000);
    expect(repo.findOpen('gmail', Date.now())?.expiresAtMs).toBe(w2.expiresAtMs);
  });

  it('close removes the row', () => {
    repo.open('gmail', 60_000);
    expect(repo.close('gmail')).toBe(true);
    expect(repo.close('gmail')).toBe(false);
    expect(repo.findOpen('gmail', Date.now())).toBeNull();
  });

  it('list returns windows in newest-first order', () => {
    repo.open('a', 60_000);
    repo.open('b', 60_000);
    const rows = repo.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.openedAtMs).toBeGreaterThanOrEqual(rows[1]!.openedAtMs);
  });

  it('cleanupExpired removes expired + consumed rows', () => {
    repo.open('expired', 1);
    repo.open('consumed', 60_000);
    repo.consume('consumed', 'x', Date.now());
    repo.open('open', 60_000);
    const removed = repo.cleanupExpired(Date.now() + 5000);
    expect(removed).toBe(2);
    expect(repo.list().map((r) => r.profile)).toEqual(['open']);
  });
});

// Database import is intentionally unused — keeping it ensures the
// migration files load cleanly during openDatabase().
void Database;
