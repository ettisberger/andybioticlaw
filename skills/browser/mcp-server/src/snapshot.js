/**
 * Page → accessibility-tree snapshot with `@eN` element refs.
 *
 * Two-step protocol:
 *   1. `tagInteractiveElements(page)` runs in the page context and
 *      assigns a `data-aax-ref="eN"` attribute to every "interactive"
 *      element (button, link, text input, …). Re-running clears prior
 *      refs first, so refs are always fresh and snapshot-local.
 *   2. `serializeSnapshot(page)` walks the page's accessibility tree
 *      and emits a compact text representation. Interactive nodes
 *      surface their ref; static text falls through as prose.
 *
 * The agent interacts by ref (`@e3`). Tool dispatch resolves
 * `[data-aax-ref="e3"]` via Playwright locators — bulletproof against
 * ambiguous role+name matches, and naturally stale after the next
 * snapshot (which re-tags).
 *
 * NOTE on iframes: we tag the top frame only. Sites embedding iframes
 * (OAuth providers, captchas) are out of scope for the snapshot/ref
 * loop — the agent should report `requires_human_intervention` rather
 * than try to drive a sub-frame it can't see.
 */

/**
 * The list of roles we treat as "interactive" — i.e. worth a ref so
 * the agent can `click`/`type`/`select` on them. Mirrors NanoClaw's
 * agent-browser tagging surface.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'textarea',
  'select',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=menuitem]',
  '[role=combobox]',
  '[role=textbox]',
  '[contenteditable=true]',
  '[contenteditable=""]',
].join(',');

/**
 * Run in the page: clear stale `data-aax-ref` attrs, then tag
 * interactive elements with `e1`, `e2`, …. Returns the count.
 */
function pageTag(selector) {
  document
    .querySelectorAll('[data-aax-ref]')
    .forEach((el) => el.removeAttribute('data-aax-ref'));
  let i = 0;
  document.querySelectorAll(selector).forEach((el) => {
    // Skip elements hidden from a11y / display: none.
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    i += 1;
    el.setAttribute('data-aax-ref', 'e' + i);
  });
  return i;
}

/**
 * Run in the page: collect each tagged element with the metadata the
 * agent needs to reason about it. Tag scan order matches the DOM order
 * so refs read top-to-bottom in the snapshot.
 */
function pageCollect() {
  const out = [];
  document.querySelectorAll('[data-aax-ref]').forEach((el) => {
    const ref = el.getAttribute('data-aax-ref');
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute('role');
    let role = explicitRole;
    if (!role) {
      if (tag === 'a' && el.hasAttribute('href')) role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'summary') role = 'button';
      else if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') role = 'checkbox';
        else if (type === 'radio') role = 'radio';
        else if (type === 'button' || type === 'submit') role = 'button';
        else role = 'textbox';
      } else role = 'element';
    }
    const name =
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const value = el.value ?? '';
    const checked = el.checked === true || undefined;
    const disabled = el.disabled === true || undefined;
    out.push({ ref, role, name, value, checked, disabled, tag });
  });
  return out;
}

/**
 * Take a snapshot. Returns:
 *   {
 *     url, title, refs: [{ ref, role, name, value? }],
 *     text: a compact textual rendering for the agent.
 *   }
 */
export async function takeSnapshot(page) {
  await page.evaluate(pageTag, INTERACTIVE_SELECTOR);
  const refs = await page.evaluate(pageCollect);
  const url = page.url();
  const title = await page.title().catch(() => '');

  const lines = [];
  lines.push(`url: ${url}`);
  if (title) lines.push(`title: ${title}`);
  if (refs.length === 0) {
    lines.push('(no interactive elements found)');
  } else {
    lines.push('elements:');
    for (const r of refs) {
      const bits = [];
      if (r.role) bits.push(r.role);
      const nm = (r.name || '').trim();
      if (nm) bits.push(JSON.stringify(nm));
      if (r.value && r.role === 'textbox') bits.push(`value=${JSON.stringify(r.value)}`);
      if (r.checked) bits.push('checked');
      if (r.disabled) bits.push('disabled');
      lines.push(`  @${r.ref}  ${bits.join(' ')}`);
    }
  }
  return { url, title, refs, text: lines.join('\n') };
}

/**
 * Resolve a ref to a Playwright locator. The CSS attribute selector
 * is unambiguous because tag scan is monotonic per snapshot.
 */
export function locatorForRef(page, ref) {
  return page.locator(`[data-aax-ref="${ref}"]`);
}

/**
 * Detect captcha / 2FA / verify-it's-you challenges. Used by every
 * tool dispatcher to populate `requires_human_intervention` in the
 * tool result so the agent branches on a structured flag rather than
 * pattern-matching prose.
 *
 * Heuristic — false positives are fine (agent stops and asks the
 * principal; principal corrects); false negatives are dangerous
 * (agent tries to drive past a CAPTCHA and gets the profile rate-limited).
 */
export async function detectIntervention(page) {
  try {
    return await page.evaluate(() => {
      const html = document.body?.innerText || '';
      if (
        document.querySelector(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="cloudflare"]',
        )
      )
        return 'captcha';
      if (document.querySelector('input[name=otp], input[name=code], input[name=mfa], input[autocomplete=one-time-code]'))
        return '2fa';
      if (/verify it'?s you|are you human|two[- ]?factor|one[- ]?time code/i.test(html))
        return 'verify';
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Walk a Playwright storageState JSON and return the soonest expiry
 * timestamp (ms) among session-y cookies, or null if there are none.
 * Used by `browser_navigate` to surface a `cookie_expiry_warning`.
 */
export function nextSessionCookieExpiry(storageState) {
  const cookies = storageState?.cookies ?? [];
  let soonest = null;
  for (const c of cookies) {
    if (typeof c.expires !== 'number' || c.expires <= 0) continue;
    const name = (c.name || '').toLowerCase();
    // Heuristic: cookies whose names typically gate a logged-in session.
    if (!/sid|session|auth|token|jwt|jsessionid|csrf/.test(name)) continue;
    const ms = c.expires * 1000; // Playwright stores epoch seconds
    if (soonest === null || ms < soonest) soonest = ms;
  }
  return soonest;
}
