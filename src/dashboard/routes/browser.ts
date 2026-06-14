import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import type { BrowserImportRepo } from '../../db/repositories/browser-import.js';
import type { AuditRepo } from '../../db/repositories/audit.js';

export interface BrowserRoutesDeps {
  currentConfig: () => Config;
  dataDir: string;
  importRepo: BrowserImportRepo;
  audit: AuditRepo;
  logger: Logger;
}

/**
 * Compute a stable sha256 of a storageState object. Canonicalize via
 * sorted-key JSON so the operator can replay the same upload and get
 * the same digest. Output is hex (64 chars).
 */
export function canonicalChecksum(obj: unknown): string {
  return createHash('sha256').update(canonicalJson(obj)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map(
        (k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}

const PROFILE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — storageState is typically < 50 KB

/**
 * POST /api/browser/profiles/:name/import
 *
 * Security gates (all must pass):
 *   1. dashboard.basicAuth.enabled MUST be true. We refuse 403
 *      regardless of any other config when basic auth is off, because
 *      cookies in storageState = full session takeover material.
 *   2. The profile name MUST be in browser.profiles[].
 *   3. An open, unconsumed, unexpired import window for this profile
 *      MUST exist (created by `andybioticlaw browser import-window open`).
 *   4. The upload body MUST be a JSON object with a `storageState`
 *      shape Playwright recognizes (cookies + origins arrays).
 *
 * On success:
 *   - Write to data/browser/profiles/<name>/pending.json (0600)
 *   - Atomically rename pending.json → storageState.json
 *   - Mark the window consumed with the checksum
 *   - Write an audit row with source IP + checksum + size
 */
export const browserRoutes =
  (deps: BrowserRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Params: { name: string } }>(
      '/api/browser/profiles/:name/import',
      async (req, reply) => {
        const cfg = deps.currentConfig();

        // Gate 1: basic auth MUST be enabled at the dashboard level.
        if (!cfg.dashboard.basicAuth.enabled) {
          deps.logger.warn(
            { ip: req.ip, profile: req.params.name },
            'browser import refused: dashboard.basicAuth.enabled=false',
          );
          deps.audit.record({
            kind: 'browser-import-refused',
            actor: 'dashboard',
            detail: { profile: req.params.name, reason: 'basicAuth disabled', ip: req.ip },
          });
          reply.code(403);
          return {
            error:
              'storageState import requires dashboard.basicAuth.enabled=true (sensitive endpoint)',
          };
        }

        // Gate 2: known profile.
        const profile = req.params.name;
        if (!PROFILE_NAME_RE.test(profile)) {
          reply.code(400);
          return { error: 'invalid profile name' };
        }
        const known = cfg.browser.profiles.find((p) => p.name === profile);
        if (!known) {
          reply.code(404);
          return { error: `profile '${profile}' not configured in browser.profiles` };
        }

        // Gate 3: open import window.
        const window = deps.importRepo.findOpen(profile, Date.now());
        if (!window) {
          deps.logger.warn(
            { ip: req.ip, profile },
            'browser import refused: no open import window',
          );
          deps.audit.record({
            kind: 'browser-import-refused',
            actor: 'dashboard',
            detail: { profile, reason: 'no open window', ip: req.ip },
          });
          reply.code(403);
          return {
            error:
              "no open import window for this profile — run 'andybioticlaw browser import-window open " +
              profile +
              "' on the VPS first",
          };
        }

        // Gate 4: parse + shape-validate body.
        const body = req.body as unknown;
        if (typeof body !== 'object' || body === null) {
          reply.code(400);
          return { error: 'body must be a JSON object' };
        }
        const storageState = (body as Record<string, unknown>).storageState;
        if (!storageState || typeof storageState !== 'object') {
          reply.code(400);
          return { error: 'body.storageState is required' };
        }
        const cookies = (storageState as Record<string, unknown>).cookies;
        const origins = (storageState as Record<string, unknown>).origins;
        if (!Array.isArray(cookies) || !Array.isArray(origins)) {
          reply.code(400);
          return {
            error: 'body.storageState must have cookies + origins arrays (Playwright shape)',
          };
        }

        const serialized = JSON.stringify(storageState);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
          reply.code(413);
          return { error: 'storageState exceeds 1 MiB limit' };
        }

        const checksum = canonicalChecksum(storageState);

        // Quarantine-then-rename: a write error mid-way doesn't corrupt
        // the existing storageState.json the agent is currently using.
        const profileDir = resolve(deps.dataDir, 'browser/profiles', profile);
        try {
          mkdirSync(profileDir, { recursive: true });
        } catch (e) {
          reply.code(500);
          return { error: `cannot create profile dir: ${(e as Error).message}` };
        }
        const pending = resolve(profileDir, 'pending.json');
        const target = resolve(profileDir, 'storageState.json');
        try {
          writeFileSync(pending, serialized, { mode: 0o600 });
          renameSync(pending, target);
        } catch (e) {
          reply.code(500);
          return { error: `write failed: ${(e as Error).message}` };
        }

        deps.importRepo.consume(profile, checksum, Date.now());
        deps.audit.record({
          kind: 'browser-import-success',
          actor: 'dashboard',
          detail: {
            profile,
            checksum,
            bytes: serialized.length,
            ip: req.ip,
          },
        });

        return {
          ok: true,
          profile,
          checksum,
          bytes: serialized.length,
          path: target,
        };
      },
    );

    app.get<{ Params: { name: string } }>(
      '/api/browser/profiles/:name/import-window',
      async (req, reply) => {
        const window = deps.importRepo.findOpen(req.params.name, Date.now());
        if (!window) {
          reply.code(404);
          return { open: false };
        }
        return {
          open: true,
          expiresAtMs: window.expiresAtMs,
          openedAtMs: window.openedAtMs,
        };
      },
    );
  };
