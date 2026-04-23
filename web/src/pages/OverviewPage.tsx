import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { apiGet, formatTs } from '../lib/api';
import { Badge, Card, ErrorBanner } from '../components/ui';

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
  principalUserId: number | null;
  bot: {
    username: string | null;
    firstName: string | null;
    hasAvatar: boolean;
  };
  credentialsOk: boolean;
  authMethod: 'session' | 'token' | 'unknown' | null;
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
  if (!data) return <div className="text-ink-dim">loading…</div>;

  return (
    <div>
      <AgentHeroCard data={data} />

      {/* Status strip */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <Card>
          <div className="text-xs uppercase text-ink-faint">Credentials</div>
          <div className="mt-1 text-lg font-medium">
            {data.credentialsOk ? <Badge tone="success">OK</Badge> : <Badge tone="error">MISSING</Badge>}
          </div>
          {data.credentialsOk && data.authMethod && (
            <div className="mt-1 text-xs text-ink-faint">via {data.authMethod}</div>
          )}
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Queue depth</div>
          <div className="mt-1 text-lg font-medium">{data.queueTotalDepth}</div>
          {Object.entries(data.queueDepths).length > 0 && (
            <div className="mt-1 text-xs text-ink-faint">
              {Object.entries(data.queueDepths).map(([chat, n]) => (
                <span key={chat} className="mr-2">
                  chat {chat}: {n}
                </span>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Skills</div>
          <div className="mt-1 text-lg font-medium">
            {data.skills.enabled} / {data.skills.total}
          </div>
          <div className="mt-1 text-xs text-ink-faint">enabled / installed</div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Schedules</div>
          <div className="mt-1 text-lg font-medium">
            {data.schedules.enabled} / {data.schedules.total}
          </div>
          <div className="mt-1 text-xs text-ink-faint">enabled / total</div>
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
          <div className="mb-2 text-sm font-medium text-ink">Recent sessions</div>
          {data.recentSessions.length === 0 && (
            <div className="text-sm text-ink-faint">(none)</div>
          )}
          {data.recentSessions.map((s) => (
            <div key={s.id} className="border-b border-line py-1.5 last:border-0 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                <span className="font-mono text-xs text-ink-faint">{s.id.slice(0, 8)}…</span>
                <span className="text-xs text-ink-faint">
                  {s.tokens_input + s.tokens_output} tok
                </span>
              </div>
              <div className="mt-0.5 text-xs text-ink-dim">
                {formatTs(s.started_at)} — {s.input_preview?.slice(0, 80) ?? ''}
              </div>
            </div>
          ))}
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-ink">Recent failures</div>
          {data.recentFailures.length === 0 && (
            <div className="text-sm text-ink-faint">(none — good)</div>
          )}
          {data.recentFailures.map((s) => (
            <div key={s.id} className="border-b border-line py-1.5 last:border-0 text-sm">
              <div className="font-mono text-xs text-ink-faint">{s.id.slice(0, 8)}…</div>
              <div className="mt-0.5 text-xs text-error-ink">{s.error}</div>
              <div className="text-xs text-ink-faint">{formatTs(s.started_at)}</div>
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
    pct >= 95 ? 'bg-error' : pct >= 75 ? 'bg-warn' : 'bg-success';
  const msToReset = Math.max(0, budget.nextResetMs - now);
  return (
    <Card className="flex flex-col">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-ink">Daily budget</div>
          <div className="text-xs text-ink-faint">local safety cap · set by you in config.yaml</div>
        </div>
        {budget.exhausted && <Badge tone="error">EXHAUSTED</Badge>}
      </div>

      <div className="mb-1.5 flex items-baseline justify-between">
        <div>
          <span className="text-2xl font-semibold text-ink">
            {formatCompact(budget.used)}
          </span>
          <span className="ml-1.5 text-sm text-ink-faint">
            / {formatCompact(budget.limit)} tokens
          </span>
        </div>
        <div className="text-sm font-medium text-ink">{pct.toFixed(1)}%</div>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div
          className={`h-full rounded-full ${barTone} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-3 flex justify-between text-xs text-ink-dim">
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
    latest?.status === 'allowed' ? 'success' : latest?.status ? 'error' : 'neutral';
  const dot =
    latest?.status === 'allowed'
      ? 'bg-success'
      : latest?.status
        ? 'bg-error'
        : 'bg-ink-faint';

  return (
    <Card className="flex flex-col">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-ink">
            Subscription window
          </div>
          <div className="text-xs text-ink-faint">
            Anthropic · 5h rolling · observed from the CLI
          </div>
        </div>
      </div>

      {!hasObservation ? (
        <div className="flex-1 rounded border border-dashed border-line bg-surface-muted px-3 py-4 text-center text-xs text-ink-faint">
          No CLI rate-limit event observed yet.
          <br />
          Send Emma a message to populate this card.
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
            <span
              className={`text-xl font-semibold ${statusTone === 'success' ? 'text-success-ink' : statusTone === 'error' ? 'text-error-ink' : 'text-ink'}`}
            >
              {latest?.status === 'allowed' ? 'Allowed' : (latest?.status ?? '—')}
            </span>
            <span className="text-ink-faint">·</span>
            <span className="text-sm text-ink">
              {resetsInMs !== null && resetsInMs > 0 && (
                <>resets in <span className="font-medium text-ink">{formatDuration(resetsInMs)}</span></>
              )}
              {resetsInMs !== null && resetsInMs <= 0 && (
                <span className="text-success-ink">reset due</span>
              )}
            </span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded bg-surface-muted px-2 py-1.5">
              <div className="text-ink-faint">Overage</div>
              <div className="mt-0.5 text-ink">
                {latest?.overageStatus === 'allowed'
                  ? 'on (pay-as-you-go)'
                  : latest?.overageStatus === 'rejected'
                    ? 'off'
                    : (latest?.overageStatus ?? '—')}
              </div>
              {latest?.overageDisabledReason && (
                <div className="mt-0.5 text-[10px] text-ink-faint">
                  {latest.overageDisabledReason.replace(/_/g, ' ')}
                </div>
              )}
            </div>
            <div className="rounded bg-surface-muted px-2 py-1.5">
              <div className="text-ink-faint">Using overage</div>
              <div className="mt-0.5 text-ink">
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

      <div className="mt-auto border-t border-line pt-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-ink-faint">
          Why no % used?
        </div>
        <div className="text-[11px] leading-relaxed text-ink-dim">
          The Claude CLI's <code>rate_limit_event</code> does not expose a
          usage count — only status + reset time. The "80% used" number in
          your Claude profile UI comes from a separate (undocumented) API
          we don't call. Below is our own local proxy; it's not Anthropic's
          meter.
        </div>
        <div className="mt-2 flex justify-between text-xs">
          <span className="text-ink-dim">Our 5h rolling (local count)</span>
          <span className="font-medium text-ink">
            {formatCompact(localEstimate)} tokens
          </span>
        </div>
        {observedAgo !== null && (
          <div className="mt-1 text-[11px] text-ink-faint">
            CLI snapshot from {formatDuration(observedAgo)} ago
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Header card at the top of the Overview. Shows the bot's Telegram avatar
 * (or a Bot-icon fallback), the agent name as a heading, and runtime
 * context chips below. Used in place of the old PageTitle.
 */
function AgentHeroCard({ data }: { data: OverviewData }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const showAvatar = data.bot.hasAvatar && !avatarFailed;

  return (
    <div className="mb-6 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-5 px-6 py-5">
        {/* Avatar */}
        <div className="shrink-0">
          {showAvatar ? (
            <img
              src="/api/agent/avatar"
              alt={data.agentName}
              onError={() => setAvatarFailed(true)}
              className="h-20 w-20 rounded-full object-cover ring-2 ring-accent-bg"
            />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent-bg text-accent-ink ring-2 ring-accent-bg/60">
              <Bot size={40} strokeWidth={1.75} aria-label={data.agentName} />
            </div>
          )}
        </div>

        {/* Identity + meta */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {data.agentName}
            </h1>
            {data.bot.username && (
              <span className="text-sm text-ink-dim">
                @{data.bot.username}
              </span>
            )}
          </div>

          <p className="text-sm text-ink-dim">
            your personal AI agent — running on{' '}
            <code className="rounded bg-surface-muted px-1.5 py-0.5 text-[12px] text-ink">
              {data.model}
            </code>{' '}
            · {data.timezone}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <HeroChip>
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  data.credentialsOk ? 'bg-success' : 'bg-error'
                }`}
              />
              credentials {data.credentialsOk ? 'OK' : 'missing'}
              {data.credentialsOk && data.authMethod && (
                <span className="text-ink-faint"> · {data.authMethod}</span>
              )}
            </HeroChip>
            {data.principalUserId !== null && (
              <HeroChip>
                principal id{' '}
                <span className="font-mono text-ink">
                  {data.principalUserId}
                </span>
              </HeroChip>
            )}
            <HeroChip>
              queue <span className="font-mono text-ink">{data.queueTotalDepth}</span>
            </HeroChip>
            <HeroChip>
              skills{' '}
              <span className="font-mono text-ink">
                {data.skills.enabled}/{data.skills.total}
              </span>
            </HeroChip>
            <HeroChip>
              schedules{' '}
              <span className="font-mono text-ink">
                {data.schedules.enabled}/{data.schedules.total}
              </span>
            </HeroChip>
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-ink-dim">
      {children}
    </span>
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
