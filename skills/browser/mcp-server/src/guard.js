/**
 * Hostname allowlist enforcement.
 *
 * Three layers of defense (described in the project plan):
 *   1. Pre-navigate check in `browser_navigate` (fast clean error).
 *   2. `context.route('**\/*', …)` aborts every disallowed request,
 *      main + subresource. See `attachRouteGuard` below.
 *   3. `page.on('framenavigated')` re-checks the final URL and force-
 *      closes if it drifted (covers data:/blob: URLs that route()
 *      doesn't fire for). See `attachNavigationGuard`.
 *
 * Hostname comparison normalizes to punycode (IDN ASCII form) before
 * comparing. This blocks homoglyph bypasses like Cyrillic-`о` in
 * `protоn.me` — pre-punycode lookup against `proton.me` would have
 * passed; post-punycode the two strings differ.
 */

import { domainToASCII } from 'node:url';

/**
 * Convert a hostname to its canonical ASCII (punycode) form.
 * - Lowercases.
 * - Punycodes non-ASCII labels (e.g. `münich.example` → `xn--mnich-kva.example`).
 * - Strips trailing dot.
 */
export function canonicalize(hostname) {
  if (!hostname) return '';
  let ascii;
  try {
    ascii = domainToASCII(hostname);
  } catch {
    ascii = '';
  }
  // domainToASCII returns '' for invalid input; fall back to lowercase.
  const out = (ascii || hostname).toLowerCase().replace(/\.$/, '');
  return out;
}

/**
 * Match a hostname against one allowlist pattern. Patterns:
 *   - exact host: "proton.me"        → matches "proton.me" AND "www.proton.me"
 *                                       (apex + www is one logical site;
 *                                        nearly every site does an apex↔www
 *                                        redirect and forcing the operator
 *                                        to list both is bad UX)
 *   - wildcard:   "*.proton.me"      → matches any sub.proton.me (≥1 label),
 *                                       NOT "proton.me" itself
 *   - bare wild:  "*"                → matches everything (intentional escape hatch)
 *
 * Pattern is canonicalized the same way as the input hostname so an
 * operator who writes `münich.example` is matched against the
 * punycoded `xn--mnich-kva.example`.
 *
 * To allow OTHER subdomains (e.g. `api.proton.me`) the operator must
 * use the wildcard form — the implicit www is the only exception.
 */
export function matchesPattern(hostname, pattern) {
  if (pattern === '*') return true;
  const host = canonicalize(hostname);
  const pat = canonicalize(pattern.replace(/^\*\./, ''));
  if (pattern.startsWith('*.')) {
    // *.proton.me → match `<anything>.proton.me`, not bare proton.me
    return host !== pat && host.endsWith('.' + pat);
  }
  // Exact apex match, or implicit `www.<pattern>`.
  return host === pat || host === `www.${pat}`;
}

/**
 * Returns null on success; on failure, returns a short reason
 * describing why the hostname was rejected.
 */
export function checkAllowed(urlOrHostname, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return 'no hostname allowlist configured — operator must set browser.hostnameAllowlist';
  }
  let hostname;
  try {
    // Permit either a full URL or a bare hostname.
    if (urlOrHostname.includes('://')) {
      hostname = new URL(urlOrHostname).hostname;
    } else {
      hostname = urlOrHostname;
    }
  } catch {
    return `invalid URL: ${urlOrHostname}`;
  }
  if (!hostname) return `URL has no hostname: ${urlOrHostname}`;
  for (const pat of allowlist) {
    if (matchesPattern(hostname, pat)) return null;
  }
  return `hostname '${hostname}' is not on browser.hostnameAllowlist`;
}

/**
 * Attach a route handler that aborts disallowed requests. The
 * `allowlistRef` is a getter so the handler always reads the LATEST
 * allowlist — supporting hot-reload of `browser.hostnameAllowlist`
 * without having to re-attach the route.
 *
 *   ⚠️ data: and blob: URLs never go through the network so route()
 *   doesn't fire — `attachNavigationGuard` covers those.
 */
export async function attachRouteGuard(context, allowlistRef) {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    // Bypass non-HTTP schemes here; the navigation guard handles them.
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      try {
        await route.continue();
      } catch {
        /* request may already be in flight */
      }
      return;
    }
    const reason = checkAllowed(url, allowlistRef());
    if (reason) {
      try {
        await route.abort('addressunreachable');
      } catch {
        /* race: page already navigated away */
      }
      return;
    }
    try {
      await route.continue();
    } catch {
      /* same race */
    }
  });
}

/**
 * Attach a `framenavigated` listener that force-closes the page if the
 * final URL of any frame falls outside the allowlist. This catches
 * navigations via data:/blob: and JS-initiated redirects to URLs that
 * route() can't intercept.
 */
export function attachNavigationGuard(page, allowlistRef, onViolation) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url === 'about:blank') return;
    // For data:/blob:/file: we can't extract a meaningful hostname —
    // refuse outright unless the allowlist contains the bare wildcard.
    if (
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('file:')
    ) {
      if (!allowlistRef().includes('*')) {
        onViolation?.(url, 'non-http scheme not permitted by allowlist');
        page
          .close({ runBeforeUnload: false })
          .catch(() => undefined);
      }
      return;
    }
    const reason = checkAllowed(url, allowlistRef());
    if (reason) {
      onViolation?.(url, reason);
      page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  });
}
