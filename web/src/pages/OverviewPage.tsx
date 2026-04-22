import { useEffect, useState } from 'react';
import { apiGet, formatTs } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle } from '../components/ui';

interface RateLimitSnapshot {
  observedAt: number;
  status: string | null;
  rateLimitType: string | null;
  resetsAtSec: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
  raw: unknown;
}

interface OverviewData {
  agentName: string;
  model: string;
  timezone: string;
  credentialsOk: boolean;
  budget: { used: number; limit: number; remaining: number; exhausted: boolean; nextResetMs: number };
  rateLimit: {
    latest: RateLimitSnapshot | null;
    localRollingFiveHourTokens: number;
  };
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
  const [now, setNow] = useState(() => Date.now());

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
    // tick every second so countdown fields feel alive
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
      clearInterval(tick);
    };
  }, []);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-slate-400">loading…</div>;

  return (
    <div>
      <PageTitle subtitle={`${data.agentName} · ${data.model} · ${data.timezone}`}>Overview</PageTitle>

      {/* Status strip */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <Card>
          <div className="text-xs uppercase text-slate-500">Credentials</div>
          <div className="mt-1 text-lg font-medium">
            {data.credentialsOk ? <Badge tone="success">OK</Badge> : <Badge tone="error">MISSING</Badge>}
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
          <div className="text-xs uppercase text-slate-500">Skills</div>
          <div className="mt-1 text-lg font-medium">
            {data.skills.enabled} / {data.skills.total}
          </div>
          <div className="mt-1 text-xs text-slate-500">enabled / installed</div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Schedules</div>
          <div className="mt-1 text-lg font-medium">
            {data.schedules.enabled} / {data.schedules.total}
          </div>
          <div className="mt-1 text-xs text-slate-500">enabled / total</div>
        </Card>
      </div>

      {/* Two budgets side by side — local daily cap + Anthropic 5h window */}
      <div className="mb-5 grid grid-cols-2 gap-4">
        <LocalBudgetCard budget={data.budget} now={now} />
        <SubscriptionWindowCard rateLimit={data.rateLimit} now={now} />
      </div>

      {/* Recent activity */}
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

function LocalBudgetCard({
  budget,
  now,
}: {
  budget: OverviewData['budget'];
  now: number;
}) {
  const pct = budget.limit > 0 ? Math.min(100, (budget.used / budget.limit) * 100) : 0;
  const barTone =
    pct >= 95 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  const msToReset = Math.max(0, budget.nextResetMs - now);
  return (
    <Card className="flex flex-col">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-200">Daily budget</div>
          <div className="text-xs text-slate-500">local safety cap · set by you in config.yaml</div>
        </div>
        {budget.exhausted && <Badge tone="error">EXHAUSTED</Badge>}
      </div>

      <div className="mb-1.5 flex items-baseline justify-between">
        <div>
          <span className="text-2xl font-semibold text-slate-100">
            {formatCompact(budget.used)}
          </span>
          <span className="ml-1.5 text-sm text-slate-500">
            / {formatCompact(budget.limit)} tokens
          </span>
        </div>
        <div className="text-sm font-medium text-slate-300">{pct.toFixed(1)}%</div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-slate-900">
        <div
          className={`h-full rounded-full ${barTone} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-3 flex justify-between text-xs text-slate-400">
        <span>{formatCompact(budget.remaining)} tokens remaining</span>
        <span>resets in {formatDuration(msToReset)}</span>
      </div>
    </Card>
  );
}

function SubscriptionWindowCard({
  rateLimit,
  now,
}: {
  rateLimit: OverviewData['rateLimit'];
  now: number;
}) {
  const latest = rateLimit.latest;
  const localEstimate = rateLimit.localRollingFiveHourTokens;
  const hasObservation = latest !== null;
  const resetsInMs = latest?.resetsAtSec ? latest.resetsAtSec * 1000 - now : null;
  const observedAgo = latest ? now - latest.observedAt : null;

  const statusTone =
    latest?.status === 'allowed' ? 'emerald' : latest?.status ? 'rose' : 'slate';
  const dot =
    latest?.status === 'allowed'
      ? 'bg-emerald-400'
      : latest?.status
        ? 'bg-rose-400'
        : 'bg-slate-500';

  return (
    <Card className="flex flex-col">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-200">
            Subscription window
          </div>
          <div className="text-xs text-slate-500">
            Anthropic · 5h rolling · observed from the CLI
          </div>
        </div>
      </div>

      {!hasObservation ? (
        <div className="flex-1 rounded border border-dashed border-slate-700 bg-slate-900/30 px-3 py-4 text-center text-xs text-slate-500">
          No CLI rate-limit event observed yet.
          <br />
          Send Emma a message to populate this card.
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
            <span
              className={`text-xl font-semibold ${statusTone === 'emerald' ? 'text-emerald-300' : statusTone === 'rose' ? 'text-rose-300' : 'text-slate-200'}`}
            >
              {latest?.status === 'allowed' ? 'Allowed' : (latest?.status ?? '—')}
            </span>
            <span className="text-slate-500">·</span>
            <span className="text-sm text-slate-300">
              {resetsInMs !== null && resetsInMs > 0 && (
                <>resets in <span className="font-medium text-slate-100">{formatDuration(resetsInMs)}</span></>
              )}
              {resetsInMs !== null && resetsInMs <= 0 && (
                <span className="text-emerald-400">reset due</span>
              )}
            </span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded bg-slate-900/40 px-2 py-1.5">
              <div className="text-slate-500">Overage</div>
              <div className="mt-0.5 text-slate-200">
                {latest?.overageStatus === 'allowed'
                  ? 'on (pay-as-you-go)'
                  : latest?.overageStatus === 'rejected'
                    ? 'off'
                    : (latest?.overageStatus ?? '—')}
              </div>
              {latest?.overageDisabledReason && (
                <div className="mt-0.5 text-[10px] text-slate-500">
                  {latest.overageDisabledReason.replace(/_/g, ' ')}
                </div>
              )}
            </div>
            <div className="rounded bg-slate-900/40 px-2 py-1.5">
              <div className="text-slate-500">Using overage</div>
              <div className="mt-0.5 text-slate-200">
                {latest?.isUsingOverage === true
                  ? 'yes'
                  : latest?.isUsingOverage === false
                    ? 'no'
                    : '—'}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-auto border-t border-slate-700 pt-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
          Why no % used?
        </div>
        <div className="text-[11px] leading-relaxed text-slate-400">
          The Claude CLI's <code>rate_limit_event</code> does not expose a
          usage count — only status + reset time. The "80% used" number in
          your Claude profile UI comes from a separate (undocumented) API
          we don't call. Below is our own local proxy; it's not Anthropic's
          meter.
        </div>
        <div className="mt-2 flex justify-between text-xs">
          <span className="text-slate-400">Our 5h rolling (local count)</span>
          <span className="font-medium text-slate-200">
            {formatCompact(localEstimate)} tokens
          </span>
        </div>
        {observedAgo !== null && (
          <div className="mt-1 text-[11px] text-slate-500">
            CLI snapshot from {formatDuration(observedAgo)} ago
          </div>
        )}
      </div>
    </Card>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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
