/**
 * Tool definitions + dispatcher for the browser skill.
 *
 * Tool surface mirrors NanoClaw's snapshot/ref loop:
 *
 *   browser_navigate({ profile, url })
 *   browser_snapshot({ profile })
 *   browser_click({ profile, ref })
 *   browser_type({ profile, ref, text, submit? })
 *   browser_select({ profile, ref, value })
 *   browser_press_key({ profile, key })
 *   browser_wait({ profile, ref?, ms? })
 *   browser_screenshot({ profile, full_page? })
 *   browser_back / browser_forward / browser_reload({ profile })
 *
 * All tools take `profile` as a required first arg. The profile name
 * is validated server-side against the configured list — a typo
 * returns "profile 'gmail-work' not configured; available: gmail-personal,
 * github" instead of a confusing Playwright error.
 *
 * Every tool result includes a structured `requires_human_intervention`
 * flag (captcha / 2fa / verify) when detected, so the agent branches
 * on a tag rather than pattern-matching prose.
 */

import { resolveSecrets, SecretMissingError } from './secret-templating.js';
import {
  detectIntervention,
  locatorForRef,
  takeSnapshot,
  nextSessionCookieExpiry,
} from './snapshot.js';

export function buildToolDefinitions() {
  const profileArg = {
    profile: {
      type: 'string',
      description:
        'Which configured profile to use. Each profile has its own logged-in identity. See the profiles list at the top of this skill.',
    },
  };
  return [
    {
      name: 'browser_navigate',
      description:
        'Open a URL in the named profile. Returns the page snapshot. The URL hostname must match the operator-configured allowlist; otherwise the call is rejected before any network traffic.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          url: {
            type: 'string',
            description: 'Absolute http(s) URL.',
          },
        },
        required: ['profile', 'url'],
      },
    },
    {
      name: 'browser_snapshot',
      description:
        "Take a fresh snapshot of the current page in the profile. Returns the URL, title, and a list of interactive elements with refs like @e1, @e2. ALWAYS call this right before each click/type — the previous snapshot's refs are stale after any interaction.",
      inputSchema: {
        type: 'object',
        properties: { ...profileArg },
        required: ['profile'],
      },
    },
    {
      name: 'browser_click',
      description: 'Click an interactive element by its ref from the most recent snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          ref: { type: 'string', description: 'Element ref, e.g. "e3" (or "@e3" — both accepted).' },
        },
        required: ['profile', 'ref'],
      },
    },
    {
      name: 'browser_type',
      description:
        'Type text into the referenced field. Supports {{SECRET_NAME}} placeholders that resolve against the skill\'s required_secrets — the recorder suppresses the post-action screenshot when a secret is used. If `submit: true`, presses Enter after typing.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          ref: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean', default: false },
        },
        required: ['profile', 'ref', 'text'],
      },
    },
    {
      name: 'browser_select',
      description: 'Select an option in a <select> by visible label or value.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          ref: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['profile', 'ref', 'value'],
      },
    },
    {
      name: 'browser_press_key',
      description: 'Press a single keyboard key (e.g. "Enter", "Escape", "ArrowDown") on the focused element.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          key: { type: 'string' },
        },
        required: ['profile', 'key'],
      },
    },
    {
      name: 'browser_wait',
      description:
        'Wait for an element to appear (by ref from the most recent snapshot) or for a fixed duration. Use this between an action and a snapshot if the page mutates async (e.g. JS render after click).',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          ref: { type: 'string', description: 'Optional — wait for this ref to be visible.' },
          ms: { type: 'integer', minimum: 100, maximum: 30_000, description: 'Optional — wait this long. Defaults to 1000ms if `ref` not provided.' },
        },
        required: ['profile'],
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Capture a PNG screenshot of the current page. Returns base64 image data and dimensions.',
      inputSchema: {
        type: 'object',
        properties: {
          ...profileArg,
          full_page: { type: 'boolean', default: false },
        },
        required: ['profile'],
      },
    },
    {
      name: 'browser_back',
      description: 'Navigate back in history.',
      inputSchema: {
        type: 'object',
        properties: { ...profileArg },
        required: ['profile'],
      },
    },
    {
      name: 'browser_forward',
      description: 'Navigate forward in history.',
      inputSchema: {
        type: 'object',
        properties: { ...profileArg },
        required: ['profile'],
      },
    },
    {
      name: 'browser_reload',
      description: 'Reload the current page.',
      inputSchema: {
        type: 'object',
        properties: { ...profileArg },
        required: ['profile'],
      },
    },
  ];
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    isError: true,
  };
}

/**
 * Validate `profile` against the configured list. Returns an error
 * result for the dispatcher to forward, or null if OK.
 */
function validateProfile(profile, configured) {
  if (typeof profile !== 'string' || !profile) {
    return errorResult('profile is required');
  }
  if (!configured.includes(profile)) {
    return errorResult(
      `profile '${profile}' not configured; available: ${configured.join(', ') || '(none — operator must add browser.profiles in config.yaml)'}`,
    );
  }
  return null;
}

/**
 * Normalize a ref: accepts "e3" and "@e3". Returns the canonical form.
 */
function normalizeRef(ref) {
  if (typeof ref !== 'string') return '';
  return ref.replace(/^@/, '').trim();
}

/**
 * Build the dispatcher closure.
 *
 * @param {object} deps
 * @param {import('./browser.js').BrowserManager} deps.browser
 * @param {import('./lock.js').ProfileLockManager} deps.locks
 * @param {() => string[]} deps.getConfiguredProfiles
 * @param {string} deps.sessionId
 * @param {import('./recorder.js').Recorder} deps.recorder
 */
export function buildDispatcher(deps) {
  async function withProfileLock(action, profile, fn) {
    deps.locks.acquire(profile, deps.sessionId, action);
    try {
      return await fn();
    } finally {
      // Phase 1 single-page-per-profile: keep the lock for the duration
      // of the tool call only. The lock fights cross-session collision,
      // not cross-tool nesting within one session.
      deps.locks.release(profile, deps.sessionId);
    }
  }

  return async function dispatch(name, args) {
    const profile = args?.profile;
    const guard = validateProfile(profile, deps.getConfiguredProfiles());
    if (guard) return guard;

    try {
      return await withProfileLock(name, profile, async () => {
        switch (name) {
          case 'browser_navigate':
            return await handleNavigate(deps, profile, args.url);
          case 'browser_snapshot':
            return await handleSnapshot(deps, profile);
          case 'browser_click':
            return await handleClick(deps, profile, args.ref);
          case 'browser_type':
            return await handleType(
              deps,
              profile,
              args.ref,
              args.text,
              !!args.submit,
            );
          case 'browser_select':
            return await handleSelect(deps, profile, args.ref, args.value);
          case 'browser_press_key':
            return await handlePressKey(deps, profile, args.key);
          case 'browser_wait':
            return await handleWait(deps, profile, args.ref, args.ms);
          case 'browser_screenshot':
            return await handleScreenshot(deps, profile, !!args.full_page);
          case 'browser_back':
            return await handleHistory(deps, profile, 'back');
          case 'browser_forward':
            return await handleHistory(deps, profile, 'forward');
          case 'browser_reload':
            return await handleHistory(deps, profile, 'reload');
          default:
            return errorResult(`unknown tool: ${name}`);
        }
      });
    } catch (e) {
      // Lock contention bubbles here.
      return errorResult(e?.message ?? String(e));
    }
  };
}

// ---------------------------------------------------------------------------
// Individual handlers. Each is responsible for:
//   - actually doing the thing in Playwright
//   - calling deps.recorder.record(...) once with the right metadata
//   - returning a tool result (textResult / errorResult)
//   - populating `requires_human_intervention` and `cookie_expiry_warning`
//     where applicable
// ---------------------------------------------------------------------------

async function withScreenshot(deps, page, action, doIt, opts = {}) {
  const result = await doIt();
  const wantScreenshot = deps.recorder.shouldScreenshot(action);
  let buffer = null;
  if (wantScreenshot && !opts.usedSecret) {
    try {
      buffer = await page.screenshot({ type: 'png', fullPage: false });
    } catch {
      /* swallow */
    }
  }
  deps.recorder.record({
    action,
    profile: opts.profile,
    targetUrl: page.url(),
    refOrSelector: opts.refOrSelector ?? null,
    outcome: result?.outcome ?? 'ok',
    errorMessage: result?.errorMessage ?? null,
    screenshotBuffer: buffer,
    usedSecret: !!opts.usedSecret,
  });
  return result?.toolResult ?? textResult({ ok: true });
}

async function handleNavigate(deps, profile, url) {
  if (typeof url !== 'string' || !url) {
    return errorResult('url is required');
  }
  const preflight = deps.browser.preflightUrl(url);
  if (preflight) return errorResult(preflight);

  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_navigate', async () => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (e) {
      // Don't give up — the page may have partially loaded.
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(`navigation failed: ${e.message}`),
      };
    }
    const snap = await takeSnapshot(page);
    const intervention = await detectIntervention(page);

    // Cookie-expiry warning — only meaningful if storageState was used.
    let cookieExpiryWarning;
    try {
      const state = await page.context().storageState();
      const soonest = nextSessionCookieExpiry(state);
      if (soonest && soonest - Date.now() < 7 * 24 * 60 * 60 * 1000) {
        cookieExpiryWarning = new Date(soonest).toISOString().slice(0, 10);
      }
    } catch {
      /* swallow */
    }

    return {
      outcome: 'ok',
      toolResult: textResult({
        ...snap,
        requires_human_intervention: intervention,
        cookie_expiry_warning: cookieExpiryWarning ?? null,
      }),
    };
  }, { profile });
}

async function handleSnapshot(deps, profile) {
  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_snapshot', async () => {
    const snap = await takeSnapshot(page);
    const intervention = await detectIntervention(page);
    return {
      outcome: 'ok',
      toolResult: textResult({ ...snap, requires_human_intervention: intervention }),
    };
  }, { profile });
}

async function handleClick(deps, profile, refRaw) {
  const ref = normalizeRef(refRaw);
  if (!ref) return errorResult('ref is required');
  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_click', async () => {
    try {
      await locatorForRef(page, ref).first().click({ timeout: 10_000 });
    } catch (e) {
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(
          `click on @${ref} failed: ${e.message}. Snapshot may be stale — call browser_snapshot before the next interaction.`,
        ),
      };
    }
    return { outcome: 'ok', toolResult: textResult({ ok: true, ref }) };
  }, { profile, refOrSelector: `@${ref}` });
}

async function handleType(deps, profile, refRaw, textArg, submit) {
  const ref = normalizeRef(refRaw);
  if (!ref) return errorResult('ref is required');
  let resolved;
  try {
    resolved = resolveSecrets(textArg);
  } catch (e) {
    if (e instanceof SecretMissingError) return errorResult(e.message);
    throw e;
  }
  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_type', async () => {
    const loc = locatorForRef(page, ref).first();
    try {
      await loc.fill(resolved.text, { timeout: 10_000 });
    } catch (e) {
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(`type into @${ref} failed: ${e.message}`),
      };
    }
    if (submit) {
      try {
        await loc.press('Enter');
      } catch (e) {
        return {
          outcome: 'error',
          errorMessage: e.message,
          toolResult: errorResult(`type ok, but submit (Enter) failed: ${e.message}`),
        };
      }
    }
    return {
      outcome: 'ok',
      toolResult: textResult({
        ok: true,
        ref,
        used_secret: resolved.usedSecret,
        submitted: !!submit,
      }),
    };
  }, { profile, refOrSelector: `@${ref}`, usedSecret: resolved.usedSecret });
}

async function handleSelect(deps, profile, refRaw, value) {
  const ref = normalizeRef(refRaw);
  if (!ref) return errorResult('ref is required');
  if (typeof value !== 'string') return errorResult('value is required');
  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_select', async () => {
    try {
      // Playwright's selectOption accepts label, value, or index — try
      // by label first (common case), then value.
      const loc = locatorForRef(page, ref).first();
      try {
        await loc.selectOption({ label: value }, { timeout: 5_000 });
      } catch {
        await loc.selectOption(value, { timeout: 5_000 });
      }
    } catch (e) {
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(`select on @${ref} failed: ${e.message}`),
      };
    }
    return { outcome: 'ok', toolResult: textResult({ ok: true, ref, value }) };
  }, { profile, refOrSelector: `@${ref}` });
}

async function handlePressKey(deps, profile, key) {
  if (typeof key !== 'string' || !key) return errorResult('key is required');
  const page = await deps.browser.getPage(profile);
  return withScreenshot(deps, page, 'browser_press_key', async () => {
    try {
      await page.keyboard.press(key);
    } catch (e) {
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(`press '${key}' failed: ${e.message}`),
      };
    }
    return { outcome: 'ok', toolResult: textResult({ ok: true, key }) };
  }, { profile, refOrSelector: key });
}

async function handleWait(deps, profile, refRaw, ms) {
  const ref = normalizeRef(refRaw);
  const page = await deps.browser.getPage(profile);
  // No screenshot for wait — it's deliberately a no-op until something
  // observable changes.
  let outcome = 'ok';
  let errorMessage = null;
  if (ref) {
    try {
      await locatorForRef(page, ref).first().waitFor({ state: 'visible', timeout: 10_000 });
    } catch (e) {
      outcome = 'error';
      errorMessage = e.message;
    }
  } else {
    const waitMs = Number.isInteger(ms) ? Math.min(30_000, Math.max(100, ms)) : 1_000;
    await page.waitForTimeout(waitMs);
  }
  deps.recorder.record({
    action: 'browser_wait',
    profile,
    targetUrl: page.url(),
    refOrSelector: ref ? `@${ref}` : `${ms ?? 1000}ms`,
    outcome,
    errorMessage,
    screenshotBuffer: null,
    usedSecret: false,
  });
  if (outcome === 'error') return errorResult(errorMessage);
  return textResult({ ok: true });
}

async function handleScreenshot(deps, profile, fullPage) {
  const page = await deps.browser.getPage(profile);
  let buffer;
  try {
    buffer = await page.screenshot({ type: 'png', fullPage });
  } catch (e) {
    return errorResult(`screenshot failed: ${e.message}`);
  }
  deps.recorder.record({
    action: 'browser_screenshot',
    profile,
    targetUrl: page.url(),
    refOrSelector: null,
    outcome: 'ok',
    errorMessage: null,
    screenshotBuffer: buffer,
    usedSecret: false,
  });
  return {
    content: [
      {
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: 'image/png',
      },
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          url: page.url(),
          full_page: fullPage,
          bytes: buffer.length,
        }),
      },
    ],
  };
}

async function handleHistory(deps, profile, action) {
  const page = await deps.browser.getPage(profile);
  const toolAction =
    action === 'back'
      ? 'browser_back'
      : action === 'forward'
      ? 'browser_forward'
      : 'browser_reload';
  return withScreenshot(deps, page, toolAction, async () => {
    try {
      if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
    } catch (e) {
      return {
        outcome: 'error',
        errorMessage: e.message,
        toolResult: errorResult(`${action} failed: ${e.message}`),
      };
    }
    const snap = await takeSnapshot(page);
    return { outcome: 'ok', toolResult: textResult(snap) };
  }, { profile });
}
