import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Locate the Chromium executable Playwright wrote under
 * `PLAYWRIGHT_BROWSERS_PATH` (= `<dataDir>/cache/playwright/`).
 *
 * Layout:
 *   <browsersDir>/
 *     chromium-<build>/        ← one dir per pinned playwright build
 *       chrome-linux/          ← older Playwright x86_64
 *       chrome-linux64/        ← current Playwright x86_64
 *       chrome-linux-arm64/    ← ARM hosts
 *         chrome              ← the actual executable
 *
 * Older versions of this helper hardcoded `chrome-linux`. Modern
 * Playwright (≥ ~1.50) renamed the per-platform subdir to
 * `chrome-linux64` on x86_64; ARM hosts get `chrome-linux-arm64`.
 * We walk any subdir whose name starts with `chrome-` so we don't
 * have to track upstream renames in source.
 *
 * Returns the absolute path to the first chrome executable we find,
 * or null if no chromium-* subdir holds one (= install was never run
 * or the download silently no-op'd).
 *
 * Linux-only today — andybioticlaw deploys on Debian/Ubuntu. macOS
 * + Windows would need their own per-platform paths
 * (`chrome-mac/Chromium.app/Contents/MacOS/Chromium`, etc.); add
 * when needed.
 */
export function findChromiumBinary(browsersDir: string): string | null {
  if (!existsSync(browsersDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(browsersDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith('chromium-')) continue;
    const chromiumDir = resolve(browsersDir, entry);
    let subdirs: string[];
    try {
      subdirs = readdirSync(chromiumDir);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      if (!sub.startsWith('chrome-')) continue;
      const candidate = resolve(chromiumDir, sub, 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
