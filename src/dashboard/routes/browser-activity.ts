import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import type { BrowserEventsRepo } from '../../db/repositories/browser-events.js';

export interface BrowserActivityRoutesDeps {
  currentConfig: () => Config;
  dataDir: string;
  events: BrowserEventsRepo;
  logger: Logger;
}

/**
 * Read-only dashboard endpoints for the browser activity feed.
 *
 *   GET  /api/browser/sessions             — recent sessions (newest first)
 *   GET  /api/browser/sessions/:id/events  — events for a session
 *   GET  /api/browser/screenshots/*        — serve a screenshot PNG
 *
 * The screenshot route validates that the requested path lies UNDER
 * data/browser/screenshots/ — defense against path traversal via the
 * `*` wildcard.
 */
export const browserActivityRoutes =
  (deps: BrowserActivityRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/browser/sessions', async () => {
      const cfg = deps.currentConfig();
      if (!cfg.browser.enabled || !cfg.browser.dashboard.enabled) {
        return { sessions: [], enabled: false };
      }
      const sessions = deps.events.listSessions(100);
      return { sessions, enabled: true };
    });

    app.get<{ Params: { id: string } }>(
      '/api/browser/sessions/:id/events',
      async (req) => {
        const cfg = deps.currentConfig();
        if (!cfg.browser.enabled || !cfg.browser.dashboard.enabled) {
          return { events: [], enabled: false };
        }
        const events = deps.events.listForSession(req.params.id);
        return { events, enabled: true };
      },
    );

    // The MCP server writes screenshots to absolute paths under
    // <dataDir>/browser/screenshots/. We accept the absolute path as a
    // query param (id-less, simpler than a wildcard route) and only
    // serve it if it resolves under the screenshots dir. This is the
    // standard "directory containment" check — must canonicalize before
    // checking the prefix.
    app.get<{ Querystring: { path?: string } }>(
      '/api/browser/screenshot',
      async (req, reply) => {
        const cfg = deps.currentConfig();
        if (!cfg.browser.enabled || !cfg.browser.dashboard.enabled) {
          reply.code(404);
          return { error: 'browser dashboard disabled' };
        }
        const path = req.query.path;
        if (!path || !isAbsolute(path)) {
          reply.code(400);
          return { error: 'path query parameter required (absolute)' };
        }
        const screenshotsRoot = resolve(deps.dataDir, 'browser/screenshots');
        const resolved = resolve(path);
        if (
          resolved !== screenshotsRoot &&
          !resolved.startsWith(screenshotsRoot + '/')
        ) {
          reply.code(403);
          return { error: 'path outside screenshots dir' };
        }
        if (!existsSync(resolved)) {
          reply.code(404);
          return { error: 'screenshot not found' };
        }
        const st = statSync(resolved);
        reply
          .header('content-type', 'image/png')
          .header('content-length', String(st.size))
          .header('cache-control', 'private, max-age=600');
        return reply.send(createReadStream(resolved));
      },
    );
  };
