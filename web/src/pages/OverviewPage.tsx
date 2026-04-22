import { useEffect, useState } from 'react';
import { apiGet, formatTs } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle } from '../components/ui';

interface OverviewData {
  agentName: string;
  model: string;
  timezone: string;
  credentialsOk: boolean;
  budget: { used: number; limit: number; remaining: number; exhausted: boolean; nextResetMs: number };
  queueDepths: Record<string, number>;
  queueTotalDepth: number;
  latestHeartbeat: { at: number; meta: { active_sessions: number; queue_depths: Record<string, number> } } | null;
  skills: { total: number; enabled: number };
  schedules: { total: number; enabled: number };
  recentSessions: Array<{ id: string; status: string; started_at: number; tokens_input: number; tokens_output: number; input_preview: string | null }>;
  recentFailures: Array<{ id: string; error: string | null; started_at: number }>;
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await apiGet<OverviewData>('/api/overview');
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-slate-400">loading…</div>;

  return (
    <div>
      <PageTitle subtitle={`${data.agentName} · ${data.model} · ${data.timezone}`}>Overview</PageTitle>

      <div className="mb-5 grid grid-cols-4 gap-4">
        <Card>
          <div className="text-xs uppercase text-slate-500">Credentials</div>
          <div className="mt-1 text-lg font-medium">
            {data.credentialsOk ? <Badge tone="success">OK</Badge> : <Badge tone="error">MISSING</Badge>}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Daily tokens</div>
          <div className="mt-1 text-lg font-medium">
            {data.budget.used.toLocaleString()} / {data.budget.limit.toLocaleString()}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            resets {formatTs(data.budget.nextResetMs)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Queue depth</div>
          <div className="mt-1 text-lg font-medium">{data.queueTotalDepth}</div>
          {Object.entries(data.queueDepths).length > 0 && (
            <div className="mt-1 text-xs text-slate-500">
              {Object.entries(data.queueDepths).map(([chat, n]) => (
                <span key={chat} className="mr-2">
                  chat {chat}: {n}
                </span>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Installed</div>
          <div className="mt-1 text-sm">
            skills: {data.skills.enabled}/{data.skills.total} enabled
          </div>
          <div className="mt-0.5 text-sm">
            schedules: {data.schedules.enabled}/{data.schedules.total} enabled
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-300">Recent sessions</div>
          {data.recentSessions.length === 0 && (
            <div className="text-sm text-slate-500">(none)</div>
          )}
          {data.recentSessions.map((s) => (
            <div key={s.id} className="border-b border-slate-800 py-1.5 last:border-0 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                <span className="font-mono text-xs text-slate-500">{s.id.slice(0, 8)}…</span>
                <span className="text-xs text-slate-500">
                  {s.tokens_input + s.tokens_output} tok
                </span>
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {formatTs(s.started_at)} — {s.input_preview?.slice(0, 80) ?? ''}
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-300">Recent failures</div>
          {data.recentFailures.length === 0 && (
            <div className="text-sm text-slate-500">(none — good)</div>
          )}
          {data.recentFailures.map((s) => (
            <div key={s.id} className="border-b border-slate-800 py-1.5 last:border-0 text-sm">
              <div className="font-mono text-xs text-slate-500">{s.id.slice(0, 8)}…</div>
              <div className="mt-0.5 text-xs text-rose-300">{s.error}</div>
              <div className="text-xs text-slate-500">{formatTs(s.started_at)}</div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function statusTone(status: string): 'neutral' | 'success' | 'warn' | 'error' | 'accent' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
    case 'queued':
      return 'accent';
    case 'cancelled':
      return 'warn';
    case 'failed':
    case 'crashed':
    case 'orphaned':
      return 'error';
    default:
      return 'neutral';
  }
}
