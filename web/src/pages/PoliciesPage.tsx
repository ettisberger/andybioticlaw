import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import {
  Badge,
  Empty,
  ErrorBanner,
  InfoBanner,
  PageTitle,
  Table,
  Td,
  Th,
} from '../components/ui';

interface ResolvedPolicyView {
  contextKey: string;
  scheduleKinds: string[];
  scheduleAgentTaskCap: number;
  execMode: 'deny' | 'allowlist' | 'full';
  execAllow: string[];
  skillsVisible: string[];
  deliverToChatId?: number;
  _label?: string;
}

interface PoliciesResponse {
  exists: boolean;
  path: string;
  file?: { version: 1; defaults?: unknown; contexts?: Record<string, unknown> };
  resolved?: ResolvedPolicyView[];
}

function execModeTone(mode: ResolvedPolicyView['execMode']): 'success' | 'warn' | 'error' {
  switch (mode) {
    case 'deny':
      return 'success'; // most restrictive — green
    case 'allowlist':
      return 'warn';
    case 'full':
      return 'error'; // permissive — red so it's visible
  }
}

export function PoliciesPage() {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<PoliciesResponse>('/api/policies')
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <PageTitle subtitle="Per-context policy: which schedule kinds may be created, what shell patterns are allowed, which skills are visible.">
        Policies
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {data && !data.exists && (
        <InfoBanner>
          <strong>{data.path}</strong> does not exist yet — it will be auto-generated on
          the next service boot.
        </InfoBanner>
      )}

      {data?.exists && (
        <div className="mb-3 text-xs font-mono text-ink-faint">
          source: {data.path}
        </div>
      )}

      {data?.resolved && data.resolved.length === 0 && (
        <Empty message="No per-context policies; only defaults apply." />
      )}

      {data?.resolved && data.resolved.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Context</Th>
              <Th>Label</Th>
              <Th>Schedule kinds</Th>
              <Th>Cap</Th>
              <Th>Exec</Th>
              <Th>Skills</Th>
            </tr>
          </thead>
          <tbody>
            {data.resolved.map((p) => (
              <tr key={p.contextKey} className="hover:bg-surface-muted/50">
                <Td className="font-mono text-xs text-info-ink">{p.contextKey}</Td>
                <Td className="text-xs text-ink-dim">{p._label ?? '—'}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {p.scheduleKinds.map((k) => (
                      <Badge key={k} tone="neutral">
                        {k}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="text-xs text-ink-dim font-mono tabular-nums">
                  {p.scheduleAgentTaskCap}
                </Td>
                <Td>
                  <Badge tone={execModeTone(p.execMode)}>{p.execMode}</Badge>
                  {p.execAllow.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.execAllow.slice(0, 3).map((pat) => (
                        <code
                          key={pat}
                          className="rounded bg-surface-muted px-1 py-0.5 text-[10px] text-ink-dim"
                        >
                          {pat}
                        </code>
                      ))}
                      {p.execAllow.length > 3 && (
                        <span className="text-[10px] text-ink-faint">
                          +{p.execAllow.length - 3} more
                        </span>
                      )}
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {p.skillsVisible.map((s) => (
                      <Badge key={s} tone={s === '*' ? 'success' : 'info'}>
                        {s}
                      </Badge>
                    ))}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {data?.exists && (
        <div className="mt-6 text-xs text-ink-faint">
          <p>
            Edit <code>{data.path}</code> directly to change policies. The file is re-read
            on every session — no service restart needed. Run <code>andybioticlaw policy
            reload</code> to validate changes before saving.
          </p>
        </div>
      )}
    </div>
  );
}
