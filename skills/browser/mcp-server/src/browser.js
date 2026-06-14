/**
 * Playwright lifecycle: per-profile launch, page reuse, teardown.
 *
 * One Chromium persistent context per profile. We re-use it for the
 * duration of the MCP-server process (= the agent session). On
 * session end (stdin close), the Claude CLI kills us; we close all
 * contexts cleanly in the SIGTERM handler.
 *
 * Decision: per-session launch (cold-start ~1-2s). Hot-pool reuse
 * across sessions would need a reaper, lock-recovery, and crash-
 * recovery code we don't want to write. Per-session matches the
 * rest of the codebase's "sessions are short-lived" assumption.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  attachNavigationGuard,
  attachRouteGuard,
  checkAllowed,
} from './guard.js';

/**
 * The Chromium launch flags required under our systemd unit:
 *
 *   --no-sandbox             — NoNewPrivileges=yes denies CAP_SYS_ADMIN,
 *                              so the Chromium setuid sandbox can't init.
 *                              The outer systemd sandbox + service-user
 *                              isolation + hostname allowlist are doing
 *                              the heavy lifting; Chromium's inner
 *                              sandbox would be redundant.
 *   --disable-dev-shm-usage  — PrivateDevices=yes strips /dev/shm.
 *                              Chromium falls back to /tmp which
 *                              PrivateTmp=yes provides per-service.
 *                              Without this flag: SIGABRT under load.
 *
 * --disable-gpu is harmless headless and avoids a noisy startup error
 * when the host has no GPU at all.
 */
const CHROMIUM_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

export class BrowserManager {
  /**
   * @param {object} opts
   * @param {string} opts.profilesDir   — absolute path to data/browser/profiles
   * @param {string} opts.browsersPath  — absolute path for PLAYWRIGHT_BROWSERS_PATH
   * @param {() => string[]} opts.getAllowlist — read latest allowlist
   * @param {(url: string, reason: string) => void} opts.onAllowlistViolation
   */
  constructor(opts) {
    this.profilesDir = opts.profilesDir;
    this.browsersPath = opts.browsersPath;
    this.getAllowlist = opts.getAllowlist;
    this.onAllowlistViolation = opts.onAllowlistViolation;
    /** @type {Map<string, import('playwright').BrowserContext>} */
    this.contexts = new Map();
    /** @type {Map<string, import('playwright').Page>} */
    this.pages = new Map();
    // Honor PLAYWRIGHT_BROWSERS_PATH at process level so Chromium binary
    // is located under data/cache/playwright (writable under systemd).
    if (this.browsersPath) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = this.browsersPath;
    }
  }

  /**
   * Get-or-launch a persistent context for `profile`. Idempotent.
   * Seeds `storageState.json` into the user-data-dir on first launch.
   */
  async getContext(profile) {
    if (this.contexts.has(profile)) return this.contexts.get(profile);

    const userDataDir = resolve(this.profilesDir, profile);
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }

    // Storage-state seeding: if the operator has dropped a
    // storageState.json next to the user-data-dir (e.g. via the
    // Phase 2 login CLI), inject it on first launch. Subsequent
    // launches use the persistent user-data-dir as-is.
    const stateFile = resolve(this.profilesDir, profile, 'storageState.json');
    let storageState;
    if (existsSync(stateFile)) {
      try {
        storageState = JSON.parse(readFileSync(stateFile, 'utf8'));
      } catch {
        // Corrupted — ignore and let Chromium start fresh. The status
        // CLI will flag the file separately.
      }
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: CHROMIUM_FLAGS,
      storageState,
      // Match recent Chrome so sites don't degrade us into legacy UA paths.
      viewport: { width: 1280, height: 800 },
    });

    await attachRouteGuard(context, this.getAllowlist);

    this.contexts.set(profile, context);
    return context;
  }

  async getPage(profile) {
    if (this.pages.has(profile)) {
      const p = this.pages.get(profile);
      if (!p.isClosed()) return p;
      this.pages.delete(profile);
    }
    const context = await this.getContext(profile);
    const page = context.pages()[0] ?? (await context.newPage());
    attachNavigationGuard(page, this.getAllowlist, this.onAllowlistViolation);
    this.pages.set(profile, page);
    return page;
  }

  /**
   * Test the allowlist BEFORE Playwright fires its first network
   * request. Cheap fast-fail path used by `browser_navigate`.
   */
  preflightUrl(url) {
    return checkAllowed(url, this.getAllowlist());
  }

  /**
   * Snapshot the current storageState to disk. Phase 1 only writes on
   * explicit close (graceful shutdown). Per-tool writes would race
   * against page-internal cookie updates.
   */
  async persistStorageState(profile) {
    const context = this.contexts.get(profile);
    if (!context) return false;
    const stateFile = resolve(this.profilesDir, profile, 'storageState.json');
    try {
      const state = await context.storageState();
      writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  async closeAll() {
    for (const [profile, context] of this.contexts.entries()) {
      try {
        await this.persistStorageState(profile);
        await context.close();
      } catch {
        /* best effort */
      }
    }
    this.contexts.clear();
    this.pages.clear();
  }
}
