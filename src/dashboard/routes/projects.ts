import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import { scanProjects, type ProjectRecord } from '../../projects/scanner.js';
import {
  readGitMetadata,
  type GitMetadata,
} from '../../projects/git-introspection.js';

export interface ProjectsRoutesDeps {
  currentConfig: () => Config;
  logger: Logger;
}

/**
 * Derived activity badge — recomputed at response time from
 * `daysSinceLastCommit` and the operator's configured `staleDays`. Lives
 * in the response (not the scan) so the operator can tune `staleDays`
 * without forcing a rescan.
 */
type Activity = 'active' | 'stale' | 'inactive' | 'unknown';

interface ProjectResponse {
  name: string;
  path: string;
  isGitRepo: boolean;
  markers: ProjectRecord['markers'];
  git: GitMetadata | null;
  activity: Activity;
}

function classifyActivity(
  daysSince: number | null,
  staleDays: number,
): Activity {
  if (daysSince === null) return 'unknown';
  if (daysSince <= staleDays) return 'active';
  if (daysSince <= staleDays * 6) return 'stale';
  return 'inactive';
}

export const projectsRoutes =
  (deps: ProjectsRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/projects', async () => {
      const cfg = deps.currentConfig().projects;

      // Default-off feature flag: respond with the same shape so the
      // frontend doesn't need conditional handling.
      if (!cfg.enabled) {
        return {
          projects: [],
          rootPath: null,
          scanWarnings: ['feature disabled in config (projects.enabled: false)'],
          skipped: [],
          failed: [],
        };
      }

      const scan = scanProjects({
        folderPath: cfg.folderPath,
        logger: deps.logger,
      });

      // Enrich git repos in parallel. Non-git projects skip the work.
      const enriched: ProjectResponse[] = await Promise.all(
        scan.projects.map(async (p): Promise<ProjectResponse> => {
          let git: GitMetadata | null = null;
          if (p.isGitRepo) {
            try {
              git = await readGitMetadata({ repoPath: p.path });
            } catch (e) {
              // Should be unreachable (readGitMetadata catches internally),
              // but defensive — one bad repo must not poison the list.
              deps.logger.warn(
                { project: p.name, err: (e as Error).message },
                'git introspection threw',
              );
            }
          }
          return {
            name: p.name,
            path: p.path,
            isGitRepo: p.isGitRepo,
            markers: p.markers,
            git,
            activity: classifyActivity(
              git?.daysSinceLastCommit ?? null,
              cfg.staleDays,
            ),
          };
        }),
      );

      return {
        projects: enriched,
        rootPath: scan.rootPath,
        scanWarnings: scan.warnings,
        skipped: scan.skipped,
        failed: scan.failed,
      };
    });
  };
