import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiGet, apiPost, formatTs } from '../lib/api';
import { Badge, Button, Empty, ErrorBanner, PageTitle } from '../components/ui';

interface SkillResponse {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  scope: string[];
  secrets: Array<{ name: string; present: boolean }>;
  mcpServers: Array<{ name: string; command: string }>;
  systemCommands: string[];
  systemCommandsOk: boolean | null;
  installedAt: number | null;
  lastEnabledAt: number | null;
  lastDisabledAt: number | null;
  lastInstallOutput: string | null;
  hasSetupWizard: boolean;
}

export function SkillsPage() {
  const [rows, setRows] = useState<SkillResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState<string | null>(null);

  async function load() {
    try {
      const d = await apiGet<{ skills: SkillResponse[] }>('/api/skills');
      setRows(d.skills);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // Poll — slow-moving data, 15 s is plenty.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  async function handleToggle(skill: SkillResponse) {
    const nextState = !skill.enabled;
    setToggling(skill.name);
    try {
      const updated = await apiPost<SkillResponse>(
        `/api/skills/${encodeURIComponent(skill.name)}/${nextState ? 'enable' : 'disable'}`,
      );
      setRows((prev) =>
        prev.map((r) => (r.name === updated.name ? updated : r)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToggling(null);
    }
  }

  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  if (error) return <ErrorBanner>{error}</ErrorBanner>;

  return (
    <div>
      <PageTitle subtitle="Installed skills. Click a row to inspect permissions, secrets, and install history.">
        Skills
      </PageTitle>
      {rows.length === 0 ? (
        <Empty message="No skills loaded. Drop a manifest.yaml + SKILL.md into skills/<name>/ and restart." />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <SkillCard
              key={s.name}
              skill={s}
              expanded={expanded.has(s.name)}
              toggling={toggling === s.name}
              onToggleExpanded={() => toggleExpanded(s.name)}
              onToggleEnabled={() => handleToggle(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  expanded,
  toggling,
  onToggleExpanded,
  onToggleEnabled,
}: {
  skill: SkillResponse;
  expanded: boolean;
  toggling: boolean;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
}) {
  const missingSecrets = skill.secrets.filter((s) => !s.present).length;
  return (
    <div className="glass glass-highlight overflow-hidden rounded-2xl">
      {/* Summary row */}
      <button
        onClick={onToggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted/50"
      >
        <span className="text-ink-faint">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <Badge tone={skill.enabled ? 'success' : 'neutral'}>
          {skill.enabled ? 'enabled' : 'disabled'}
        </Badge>
        <span className="font-medium text-ink">{skill.name}</span>
        <span className="text-xs text-ink-faint">v{skill.version}</span>
        <span className="flex-1 truncate text-sm text-ink-dim">
          {skill.description}
        </span>
        {missingSecrets > 0 && (
          <Badge tone="warn">
            {missingSecrets} secret{missingSecrets > 1 ? 's' : ''} missing
          </Badge>
        )}
        {skill.systemCommandsOk === false && (
          <Badge tone="error">missing binary</Badge>
        )}
      </button>

      {/* Detail panel */}
      {expanded && (
        <div className="border-t border-line bg-surface-muted/30 px-4 py-4">
          <div className="grid grid-cols-2 gap-6">
            {/* Left column */}
            <div className="space-y-4">
              <DetailRow label="Scope">
                <code className="text-xs text-ink">{skill.scope.join(', ')}</code>
              </DetailRow>

              <DetailRow label="Required secrets">
                {skill.secrets.length === 0 ? (
                  <span className="text-xs text-ink-faint">none</span>
                ) : (
                  <ul className="space-y-0.5">
                    {skill.secrets.map((sec) => (
                      <li key={sec.name} className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            sec.present ? 'bg-success' : 'bg-error'
                          }`}
                        />
                        <code className="text-xs text-ink">{sec.name}</code>
                        <span className="text-[10px] text-ink-faint">
                          {sec.present ? 'set' : 'missing from .env'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </DetailRow>

              <DetailRow label="System commands">
                {skill.systemCommands.length === 0 ? (
                  <span className="text-xs text-ink-faint">none</span>
                ) : (
                  <ul className="space-y-0.5">
                    {skill.systemCommands.map((cmd) => (
                      <li key={cmd} className="flex items-center gap-2">
                        <code className="text-xs text-ink">{cmd}</code>
                      </li>
                    ))}
                    {skill.systemCommandsOk === false && (
                      <li className="text-xs text-error-ink">
                        one or more commands not on PATH
                      </li>
                    )}
                  </ul>
                )}
              </DetailRow>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <DetailRow label="MCP servers">
                {skill.mcpServers.length === 0 ? (
                  <span className="text-xs text-ink-faint">
                    none — skill talks to external CLI via Bash
                  </span>
                ) : (
                  <ul className="space-y-0.5">
                    {skill.mcpServers.map((srv) => (
                      <li key={srv.name} className="text-xs text-ink">
                        <code>{srv.name}</code>{' '}
                        <span className="text-ink-faint">→ {srv.command}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </DetailRow>

              <DetailRow label="Install state">
                <div className="space-y-0.5 text-xs text-ink-dim">
                  <div>
                    installed{' '}
                    <span className="text-ink">{formatTs(skill.installedAt)}</span>
                  </div>
                  {skill.lastEnabledAt && (
                    <div>
                      last enabled{' '}
                      <span className="text-ink">
                        {formatTs(skill.lastEnabledAt)}
                      </span>
                    </div>
                  )}
                  {skill.lastDisabledAt && (
                    <div>
                      last disabled{' '}
                      <span className="text-ink">
                        {formatTs(skill.lastDisabledAt)}
                      </span>
                    </div>
                  )}
                </div>
              </DetailRow>
            </div>
          </div>

          {/* install.sh output */}
          {skill.lastInstallOutput && (
            <div className="mt-4">
              <details>
                <summary className="cursor-pointer text-xs uppercase text-ink-faint hover:text-ink-dim">
                  last install output
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto rounded border border-line bg-surface p-3 text-[11px] text-ink-dim">
                  {skill.lastInstallOutput}
                </pre>
              </details>
            </div>
          )}

          {/* Actions */}
          <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
            <Button
              variant={skill.enabled ? 'default' : 'primary'}
              onClick={onToggleEnabled}
              disabled={toggling}
            >
              {toggling
                ? 'updating…'
                : skill.enabled
                  ? 'disable'
                  : 'enable'}
            </Button>
            {skill.hasSetupWizard && (
              <span className="text-xs text-ink-faint">
                reconfigure via{' '}
                <code className="rounded bg-surface px-1 py-0.5 text-ink">
                  andybioticlaw skill setup {skill.name}
                </code>{' '}
                on the VPS
              </span>
            )}
          </div>
        </div>
      )}
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
