import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { createAuditRepo } from '../../src/db/repositories/audit.js';
import { createBrowserImportRepo } from '../../src/db/repositories/browser-import.js';
import { browserRoutes, canonicalChecksum } from '../../src/dashboard/routes/browser.js';
import type { Config } from '../../src/config/schema.js';

const SILENT = pino({ level: 'silent' });

function makeConfig(opts: {
  basicAuthEnabled: boolean;
  profiles: Array<{ name: string; description?: string }>;
}): Config {
  return {
    dashboard: { basicAuth: { enabled: opts.basicAuthEnabled } },
    browser: {
      enabled: true,
      hostnameAllowlist: [],
      profiles: opts.profiles,
      defaultProfile: undefined,
      dashboard: {
        enabled: true,
        retentionDays: 7,
        retentionMb: 50,
        screenshotOnSnapshot: false,
      },
    },
  } as unknown as Config;
}

const SAMPLE_STATE = {
  cookies: [
    {
      name: 'sid',
      value: 'abc',
      domain: 'proton.me',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [],
};

async function withApp(opts: {
  cfgOverrides?: Partial<Parameters<typeof makeConfig>[0]>;
  setup?: (deps: {
    importRepo: ReturnType<typeof createBrowserImportRepo>;
    dataDir: string;
  }) => void;
}): Promise<{
  app: FastifyInstance;
  dataDir: string;
  cleanup: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'andy-br-route-'));
  const handle = openDatabase(resolve(dataDir, 'test.db'), SILENT);
  const importRepo = createBrowserImportRepo(handle.db);
  const audit = createAuditRepo(handle.db);
  const cfg = makeConfig({
    basicAuthEnabled: opts.cfgOverrides?.basicAuthEnabled ?? true,
    profiles: opts.cfgOverrides?.profiles ?? [{ name: 'gmail' }],
  });
  opts.setup?.({ importRepo, dataDir });
  const app = Fastify({ logger: false });
  await app.register(
    browserRoutes({
      currentConfig: () => cfg,
      dataDir,
      importRepo,
      audit,
      logger: SILENT,
    }),
  );
  return {
    app,
    dataDir,
    cleanup: async () => {
      await app.close();
      handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('POST /api/browser/profiles/:name/import', () => {
  let ctx: Awaited<ReturnType<typeof withApp>> | null = null;
  afterEach(async () => {
    await ctx?.cleanup();
    ctx = null;
  });

  it('refuses with 403 when dashboard.basicAuth.enabled=false', async () => {
    ctx = await withApp({
      cfgOverrides: { basicAuthEnabled: false },
      setup: ({ importRepo }) => {
        importRepo.open('gmail', 60_000);
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/basicAuth/);
  });

  it('refuses with 404 when profile is not configured', async () => {
    ctx = await withApp({
      setup: ({ importRepo }) => {
        importRepo.open('unknown', 60_000);
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/unknown/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(r.statusCode).toBe(404);
  });

  it('refuses with 403 when no import window is open', async () => {
    ctx = await withApp({});
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/import window/);
  });

  it('refuses with 400 when body is missing storageState', async () => {
    ctx = await withApp({
      setup: ({ importRepo }) => {
        importRepo.open('gmail', 60_000);
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { foo: 'bar' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('refuses with 400 when storageState lacks Playwright shape', async () => {
    ctx = await withApp({
      setup: ({ importRepo }) => {
        importRepo.open('gmail', 60_000);
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: { cookies: 'not an array' } },
    });
    expect(r.statusCode).toBe(400);
  });

  it('on success, writes the file + marks the window consumed + returns the checksum', async () => {
    ctx = await withApp({
      setup: ({ importRepo }) => {
        importRepo.open('gmail', 60_000);
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.profile).toBe('gmail');
    expect(body.checksum).toBe(canonicalChecksum(SAMPLE_STATE));

    const target = resolve(ctx.dataDir, 'browser/profiles/gmail/storageState.json');
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, 'utf8'));
    expect(written.cookies).toHaveLength(1);
  });

  it('after success, a second upload is refused (window consumed)', async () => {
    ctx = await withApp({
      setup: ({ importRepo }) => {
        importRepo.open('gmail', 60_000);
      },
    });
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/browser/profiles/gmail/import',
      payload: { storageState: SAMPLE_STATE },
    });
    expect(second.statusCode).toBe(403);
  });
});

describe('canonicalChecksum', () => {
  it('is stable under key reordering', () => {
    const a = { a: 1, b: 2, c: { x: 1, y: 2 } };
    const b = { c: { y: 2, x: 1 }, b: 2, a: 1 };
    expect(canonicalChecksum(a)).toBe(canonicalChecksum(b));
  });

  it('differs when values differ', () => {
    expect(canonicalChecksum({ a: 1 })).not.toBe(canonicalChecksum({ a: 2 }));
  });
});
