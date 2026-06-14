#!/usr/bin/env node
/**
 * andybioticlaw browser-login helper.
 *
 * Runs on the OPERATOR'S LAPTOP — not on the VPS. Opens a headed
 * Chromium window via Playwright, lets the operator log into a site,
 * captures the resulting storageState (cookies + localStorage), and
 * either:
 *   - uploads it to the dashboard's
 *     POST /api/browser/profiles/<name>/import endpoint, OR
 *   - writes it to a local file (for manual scp).
 *
 * Usage:
 *
 *   # Upload mode (default for the documented happy path):
 *   npx -p playwright@1.52.0 node scripts/browser-login.mjs \
 *     --profile <name> \
 *     --upload https://vps:3000/api/browser/profiles/<name>/import \
 *     --basic-auth user:password
 *
 *   # Local-file mode (no dashboard upload):
 *   npx -p playwright@1.52.0 node scripts/browser-login.mjs \
 *     --profile <name> \
 *     --output ./storageState-<name>.json
 *
 * Both modes need a real, working Playwright install. The npx-prefix in
 * the command above takes care of that without polluting your laptop's
 * global node_modules.
 *
 * The script does NOT need any of the andybioticlaw runtime — it's a
 * self-contained Playwright + node:https script. The point is to make
 * the "log in once" ceremony as small as possible.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const out = { profile: null, upload: null, output: null, basicAuth: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--profile') { out.profile = v; i++; }
    else if (a === '--upload') { out.upload = v; i++; }
    else if (a === '--output') { out.output = v; i++; }
    else if (a === '--basic-auth') { out.basicAuth = v; i++; }
    else if (a === '-h' || a === '--help') {
      process.stdout.write(printHelp());
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  return `\nbrowser-login.mjs — capture a storageState.json for one site profile\n\n` +
    `Required:\n  --profile <name>           profile name configured in andybioticlaw\n\n` +
    `Output (choose one):\n  --upload <url>             POST the storageState to a dashboard endpoint\n  --output <path>            write to a local file (you scp it yourself)\n\n` +
    `Upload-only:\n  --basic-auth <user:pass>   dashboard basic-auth credentials\n\n` +
    `Flow:\n  1. Chromium opens in a window — you log into the target site.\n  2. Close the Chromium window (Cmd-Q / Alt-F4) when fully logged in.\n  3. The script captures storageState and either uploads it or writes it.\n`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) {
    process.stderr.write('error: --profile is required\n' + printHelp());
    process.exit(64);
  }
  if (!args.upload && !args.output) {
    process.stderr.write('error: pass either --upload <url> or --output <path>\n' + printHelp());
    process.exit(64);
  }
  if (args.upload && !args.basicAuth) {
    process.stderr.write(
      'error: --upload requires --basic-auth <user:pass> (the dashboard endpoint refuses unauthenticated uploads)\n',
    );
    process.exit(64);
  }

  // Lazy-import Playwright so the rest of the CLI flags can be parsed
  // even on machines that don't have it installed yet (then the user
  // sees a clear "install playwright" message rather than a stack
  // trace).
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    process.stderr.write(
      "error: playwright is not installed.\n  Run:  npx -p playwright@1.52.0 node " + process.argv[1] + " --profile ... \n  (or `npm i -g playwright` to keep it permanently)\n",
    );
    process.exit(70);
  }

  process.stdout.write(
    `\n▸ Launching Chromium for profile '${args.profile}'…\n  Log into the target site, then close the Chromium window when fully logged in.\n\n`,
  );

  // We don't reuse the operator's normal Chrome profile — fresh, isolated
  // context every time so the captured state ONLY contains what was
  // entered during this session.
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('about:blank');

  // Wait for the operator to close the window. Playwright fires 'close'
  // on the BrowserContext when chromium exits.
  await new Promise((resolve) => {
    context.on('close', resolve);
  });

  const state = await context.storageState();
  const cookiesCount = state.cookies?.length ?? 0;
  const originsCount = state.origins?.length ?? 0;
  process.stdout.write(
    `\n▸ Captured storageState: ${cookiesCount} cookies, ${originsCount} origins.\n`,
  );

  const serialized = JSON.stringify(state);
  const checksum = createHash('sha256').update(canonicalJson(state)).digest('hex');
  process.stdout.write(`  sha256: ${checksum}\n  bytes:  ${serialized.length}\n\n`);

  if (args.output) {
    writeFileSync(args.output, serialized, { mode: 0o600 });
    process.stdout.write(`✓ wrote storageState to ${args.output}\n`);
    process.stdout.write(
      `  Next step (on VPS):\n` +
        `    mkdir -p /opt/andybioticlaw/data/browser/profiles/${args.profile}/\n` +
        `    cp ${args.output} /opt/andybioticlaw/data/browser/profiles/${args.profile}/storageState.json\n` +
        `    chmod 600 /opt/andybioticlaw/data/browser/profiles/${args.profile}/storageState.json\n`,
    );
    return;
  }

  // Upload mode — bootstrap CSRF (the dashboard requires the
  // double-submit cookie on POST), then POST with Authorization + the
  // X-CSRF-Token header.
  const url = new URL(args.upload);
  const auth = 'Basic ' + Buffer.from(args.basicAuth).toString('base64');

  process.stdout.write(`▸ Bootstrapping CSRF from ${url.origin}…\n`);
  const csrfRes = await fetch(`${url.origin}/api/sessions?limit=1`, {
    headers: { Authorization: auth },
  });
  const setCookie = csrfRes.headers.get('set-cookie') ?? '';
  const csrfMatch = setCookie.match(/_abl_csrf=([^;]+)/);
  if (!csrfMatch) {
    process.stderr.write(
      'error: dashboard did not set the _abl_csrf cookie — check the URL + basic-auth credentials\n' +
        `  status: ${csrfRes.status}\n`,
    );
    process.exit(2);
  }
  const csrfToken = csrfMatch[1];
  process.stdout.write(`  ✓ csrf token obtained\n\n`);

  process.stdout.write(`▸ Uploading to ${url.toString()}…\n`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'X-CSRF-Token': csrfToken,
      Cookie: `_abl_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ storageState: state }),
  });
  const responseText = await res.text();
  if (!res.ok) {
    process.stderr.write(`✗ upload failed (HTTP ${res.status}):\n  ${responseText}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ upload succeeded.\n  ${responseText}\n`);
}

main().catch((e) => {
  process.stderr.write(`browser-login: ${e?.stack ?? e}\n`);
  process.exit(1);
});
