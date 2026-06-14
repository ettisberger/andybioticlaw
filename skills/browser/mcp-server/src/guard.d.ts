/**
 * Type declarations for the JS-implemented guard module. The runtime
 * sits in skills/ (ESM .js for zero-build dev ergonomics) so tsc has
 * nothing to infer from — these declarations cover the public surface
 * used by tests + by tsc-typechecked callers.
 */

import type { BrowserContext, Page } from 'playwright';

export function canonicalize(hostname: string): string;

export function matchesPattern(hostname: string, pattern: string): boolean;

export function checkAllowed(
  urlOrHostname: string,
  allowlist: readonly string[],
): string | null;

export function attachRouteGuard(
  context: BrowserContext,
  allowlistRef: () => readonly string[],
): Promise<void>;

export function attachNavigationGuard(
  page: Page,
  allowlistRef: () => readonly string[],
  onViolation?: (url: string, reason: string) => void,
): void;
