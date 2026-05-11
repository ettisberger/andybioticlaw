import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Badge, Empty, ErrorBanner, PageTitle } from '../components/ui';

interface ProjectMarkers {
  hasDockerfile: boolean;
  hasPackageJson: boolean;
  hasRequirementsTxt: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasReadme: boolean;
}

interface GitLastCommit {
  sha: string;
  date: string;
  subject: string;
  author: string;
}

interface GitMetadata {
  branch: string | null;
  lastCommit: GitLastCommit | null;
  remoteUrl: string | null;
  isDirty: boolean;
  daysSinceLastCommit: number | null;
  errors: Record<string, string>;
}

type Activity = 'active' | 'stale' | 'inactive' | 'unknown';

interface ProjectResponse {
  name: string;
  path: string;
  isGitRepo: boolean;
  markers: ProjectMarkers;
  git: GitMetadata | null;
  activity: Activity;
}

interface ProjectsResponse {
  projects: ProjectResponse[];
  rootPath: string | null;
  scanWarnings: string[];
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; error: string }>;
}

const ACTIVITY_TONE: Record<Activity, 'success' | 'warn' | 'neutral'> = {
  active: 'success',
  stale: 'warn',
  inactive: 'neutral',
  unknown: 'neutral',
};

export function ProjectsPage() {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const d = await apiGet<ProjectsResponse>('/api/projects');
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // 30s — workspace state doesn't move second-to-second.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-ink-dim">loading…</div>;

  const featureDisabled = data.scanWarnings.some((w) =>
    w.includes('feature disabled'),
  );

  return (
    <div>
      <PageTitle
        subtitle={
          data.rootPath
            ? `Workspace overview at ${data.rootPath}. Polled every 30 seconds.`
            : 'Read-only workspace overview. Set projects.enabled: true in config.yaml to scan a folder of git repos.'
        }
      >
        Projects
      </PageTitle>

      {data.scanWarnings.length > 0 && !featureDisabled && (
        <div className="mb-4">
          <ErrorBanner>{data.scanWarnings.join(' · ')}</ErrorBanner>
        </div>
      )}

      {data.failed.length > 0 && (
        <div className="mb-4 rounded-2xl border border-line bg-surface-muted/30 px-4 py-3 text-xs text-ink-dim">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            failed to scan
          </div>
          {data.failed.map((f) => (
            <div key={f.name}>
              <code className="text-ink">{f.name}</code> — {f.error}
            </div>
          ))}
        </div>
      )}

      {data.projects.length === 0 ? (
        <Empty
          message={
            featureDisabled
              ? 'Projects page is off. Set projects.enabled: true in config.yaml to enable.'
              : 'No projects found. Check projects.folderPath in config.yaml.'
          }
        />
      ) : (
        <div className="space-y-2">
          {data.projects.map((p) => (
            <ProjectCard
              key={p.name}
              project={p}
              expanded={expanded.has(p.name)}
              onToggleExpanded={() => toggleExpanded(p.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  expanded,
  onToggleExpanded,
}: {
  project: ProjectResponse;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { git } = project;
  return (
    <div className="glass glass-highlight overflow-hidden rounded-2xl">
      <button
        onClick={onToggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted/50"
      >
        <span className="text-ink-faint">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <Badge tone={ACTIVITY_TONE[project.activity]}>
          {project.activity === 'unknown' && !project.isGitRepo
            ? 'no git'
            : project.activity}
        </Badge>
        <span className="font-medium text-ink">{project.name}</span>
        {git?.branch && (
          <span className="text-xs text-ink-faint">
            <code>{git.branch}</code>
          </span>
        )}
        <span className="flex-1 truncate text-sm text-ink-dim">
          {git?.lastCommit?.subject ?? (project.isGitRepo ? '(no commits)' : '')}
        </span>
        {git?.isDirty && <Badge tone="warn">dirty</Badge>}
        {project.activity !== 'unknown' &&
          git?.daysSinceLastCommit !== null &&
          git?.daysSinceLastCommit !== undefined && (
            <span className="text-xs text-ink-faint">
              {formatDays(git.daysSinceLastCommit)}
            </span>
          )}
      </button>

      {expanded && (
        <div className="border-t border-line bg-surface-muted/30 px-4 py-4">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-4">
              <DetailRow label="Path">
                <code className="text-xs text-ink">{project.path}</code>
              </DetailRow>

              <DetailRow label="Markers">
                <MarkersList markers={project.markers} />
              </DetailRow>

              {git?.remoteUrl && (
                <DetailRow label="Remote">
                  <code className="text-xs text-ink">{git.remoteUrl}</code>
                </DetailRow>
              )}
            </div>

            <div className="space-y-4">
              {git?.lastCommit && (
                <DetailRow label="Last commit">
                  <div className="space-y-0.5 text-xs text-ink-dim">
                    <div>
                      <code className="text-ink">{git.lastCommit.sha}</code>{' '}
                      <span className="text-ink">
                        {git.lastCommit.subject}
                      </span>
                    </div>
                    <div>
                      by <span className="text-ink">{git.lastCommit.author}</span>{' '}
                      on{' '}
                      <span className="text-ink">
                        {formatDate(git.lastCommit.date)}
                      </span>
                    </div>
                  </div>
                </DetailRow>
              )}

              {git && Object.keys(git.errors).length > 0 && (
                <DetailRow label="Git errors">
                  <ul className="space-y-0.5 text-xs text-error-ink">
                    {Object.entries(git.errors).map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v}
                      </li>
                    ))}
                  </ul>
                </DetailRow>
              )}

              {!project.isGitRepo && (
                <DetailRow label="Git">
                  <span className="text-xs text-ink-faint">
                    not a git repository
                  </span>
                </DetailRow>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MarkersList({ markers }: { markers: ProjectMarkers }) {
  const labels: Array<[boolean, string]> = [
    [markers.hasDockerfile, 'Dockerfile'],
    [markers.hasPackageJson, 'package.json'],
    [markers.hasRequirementsTxt, 'requirements.txt'],
    [markers.hasGoMod, 'go.mod'],
    [markers.hasCargoToml, 'Cargo.toml'],
    [markers.hasReadme, 'README'],
  ];
  const present = labels.filter(([p]) => p).map(([, l]) => l);
  if (present.length === 0) {
    return <span className="text-xs text-ink-faint">none</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {present.map((l) => (
        <code
          key={l}
          className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink"
        >
          {l}
        </code>
      ))}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

function formatDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
