import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { projectsRoutes } from '../../src/dashboard/routes/projects.js';
import type { Config } from '../../src/config/schema.js';

const SILENT_LOGGER = pino({ level: 'silent' });

/**
 * Minimal `Config` factory — only the `projects` slice matters here.
 * The route handler narrows to `cfg.projects` immediately so the rest
 * of the schema doesn't need to be filled in. Cast to Config because
 * the strict shape is irrelevant for these tests.
 */
function makeConfig(projects: { enabled: boolean; folderPath: string; staleDays: number }): Config {
  return { projects } as unknown as Config;
}

async function withApp(
  cfg: Config,
  fn: (app: ReturnType<typeof Fastify>) => Promise<void>,
): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(
    projectsRoutes({
      currentConfig: () => cfg,
      logger: SILENT_LOGGER,
    }),
  );
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

describe('GET /api/projects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'andy-projects-route-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the disabled-shape when projects.enabled is false', async () => {
    const cfg = makeConfig({ enabled: false, folderPath: dir, staleDays: 90 });
    await withApp(cfg, async (app) => {
      const r = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.projects).toEqual([]);
      expect(body.scanWarnings[0]).toMatch(/disabled in config/);
    });
  });

  it('returns scan warning when folder is missing', async () => {
    const cfg = makeConfig({
      enabled: true,
      folderPath: resolve(dir, 'nope'),
      staleDays: 90,
    });
    await withApp(cfg, async (app) => {
      const r = await app.inject({ method: 'GET', url: '/api/projects' });
      const body = r.json();
      expect(body.projects).toEqual([]);
      expect(body.scanWarnings[0]).toMatch(/not found/);
    });
  });

  it('lists projects with markers + activity badges', async () => {
    // Two projects: one with a fresh git commit, one with no git at all.
    const fresh = resolve(dir, 'fresh-app');
    mkdirSync(fresh);
    writeFileSync(resolve(fresh, 'Dockerfile'), '');
    writeFileSync(resolve(fresh, 'package.json'), '{}');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: fresh });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: fresh });
    execFileSync('git', ['add', '-A'], { cwd: fresh });
    execFileSync('git', ['commit', '-q', '-m', 'init'], {
      cwd: fresh,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });

    const noGit = resolve(dir, 'plain-folder');
    mkdirSync(noGit);
    writeFileSync(resolve(noGit, 'README.md'), '#');

    const cfg = makeConfig({ enabled: true, folderPath: dir, staleDays: 90 });
    await withApp(cfg, async (app) => {
      const r = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.projects).toHaveLength(2);
      const byName = Object.fromEntries(
        body.projects.map((p: { name: string }) => [p.name, p]),
      );
      expect(byName['fresh-app'].activity).toBe('active');
      expect(byName['fresh-app'].isGitRepo).toBe(true);
      expect(byName['fresh-app'].markers.hasDockerfile).toBe(true);
      expect(byName['fresh-app'].git.branch).toBe('main');
      expect(byName['plain-folder'].activity).toBe('unknown');
      expect(byName['plain-folder'].isGitRepo).toBe(false);
      expect(byName['plain-folder'].git).toBeNull();
    });
  });
});
