#!/usr/bin/env node
/**
 * Browser skill MCP server. Spawned per agent session by the core
 * service when the browser skill is active for the session's scope.
 *
 * Environment contract (injected via memoryMcpEnv in src/agent/session.ts):
 *   ANDYBIOTICLAW_CONFIG_PATH  — absolute path to config/config.yaml
 *   ANDYBIOTICLAW_DB_PATH      — absolute path to sqlite DB (for recorder)
 *   ANDYBIOTICLAW_SESSION_ID   — current session id (for recorder + locks)
 *   ANDYBIOTICLAW_CHAT_ID      — current chat id (unused by browser today)
 *   PLAYWRIGHT_BROWSERS_PATH   — set per session.ts to data/cache/playwright
 *
 * Plus any secrets declared in the skill manifest's required_secrets,
 * available as plain process.env keys (used by secret-templating.js).
 */

import { watch } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readBrowserConfig,
  resolveConfigPath,
  resolveRuntimePaths,
} from './src/config.js';
import { BrowserManager } from './src/browser.js';
import { ProfileLockManager } from './src/lock.js';
import { Recorder } from './src/recorder.js';
import { buildDispatcher, buildToolDefinitions } from './src/tools.js';

const SERVER_NAME = 'browser';

// ---------------------------------------------------------------------------
// Boot: resolve paths, read initial config.
// ---------------------------------------------------------------------------

const configPath = resolveConfigPath();
let runtimePaths;
try {
  runtimePaths = resolveRuntimePaths(configPath);
} catch (e) {
  process.stderr.write(`browser-mcp-server: ${e.message}\n`);
  process.exit(64);
}

// Mutable view of the current allowlist + profile list. Re-read from
// disk on file change so a SIGHUP-style edit to `browser.hostnameAllowlist`
// takes effect inside the running MCP server without restart.
let currentConfig;
try {
  currentConfig = readBrowserConfig(configPath);
} catch (e) {
  process.stderr.write(`browser-mcp-server: ${e.message}\n`);
  process.exit(64);
}

const sessionId = process.env.ANDYBIOTICLAW_SESSION_ID || 'no-session';
const locks = new ProfileLockManager();
const recorder = new Recorder({
  screenshotsDir: runtimePaths.screenshotsDir,
  screenshotOnSnapshot: currentConfig.dashboard.screenshotOnSnapshot,
});
const browser = new BrowserManager({
  profilesDir: runtimePaths.profilesDir,
  browsersPath: runtimePaths.browsersPath,
  getAllowlist: () => currentConfig.hostnameAllowlist,
  onAllowlistViolation: (url, reason) => {
    process.stderr.write(
      `browser: allowlist violation closed page — url=${url} reason=${reason}\n`,
    );
  },
});

// Hot-reload on file changes. Profile list changes are RESTART_REQUIRED
// in the parent (see src/config/schema.ts) so by the time the MCP server
// is reloading after a config edit, the profile list it sees is already
// the new one. The allowlist is genuinely hot-reloadable.
try {
  watch(configPath, { persistent: false }, () => {
    try {
      const next = readBrowserConfig(configPath);
      currentConfig = next;
    } catch (e) {
      process.stderr.write(
        `browser-mcp-server: config reload failed — keeping previous values: ${e.message}\n`,
      );
    }
  });
} catch {
  /* watch is best-effort; missing inotify is non-fatal */
}

// ---------------------------------------------------------------------------
// MCP server.
// ---------------------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const tools = buildToolDefinitions();
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const dispatch = buildDispatcher({
  browser,
  locks,
  getConfiguredProfiles: () => currentConfig.profiles.map((p) => p.name),
  sessionId,
  recorder,
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  return dispatch(name, args);
});

// ---------------------------------------------------------------------------
// Crash supervisor: trap any unhandled rejection, log context, and exit 1.
// The Claude CLI respawns the MCP server, so the agent can recover from
// transient Playwright failures within the same session.
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `browser-mcp-server: unhandledRejection — ${reason instanceof Error ? reason.stack : reason}\n`,
  );
  shutdown(1);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(
    `browser-mcp-server: uncaughtException — ${err.stack ?? err}\n`,
  );
  shutdown(1);
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  locks.releaseAll();
  await browser.closeAll();
  recorder.close();
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ---------------------------------------------------------------------------
// Transport.
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);