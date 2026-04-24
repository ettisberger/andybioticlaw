import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle } from '../components/ui';
import { estimateUsd, formatUsd } from '../lib/pricing';
import { DailyTokensBar } from '../components/charts/DailyTokensBar';
import { ModelDonut, SLICE_COLORS } from '../components/charts/ModelDonut';

interface DailyBucket {
  date: string;
  tokens: number;
}

interface PerModel {
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  sessions: number;
}

interface StatsResponse {
  daily: DailyBucket[];
  perModel: PerModel[];
  last7: { tokensIn: number; tokensOut: number; sessions: number };
  totalUsd: number;
  monthlyProjectionUsd: number | null;
  ratesVersion: string;
  days: number;
}

export function StatsPage() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<14 | 30>(30);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await apiGet<StatsResponse>(`/api/stats?days=${days}`);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const t = setInterval(load, 15_000); // slower poll than Overview; daily data barely moves
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [days]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-ink-dim">loading…</div>;

  const totalTokens = data.daily.reduce((a, b) => a + b.tokens, 0);
  const totalSessions = data.perModel.reduce((a, b) => a + b.sessions, 0);

  return (
    <div>
      <PageTitle subtitle="Token usage + API-list-price equivalent cost over time.">
        Stats
      </PageTitle>

      {/* Caveat — placed above the numbers, not below, so nobody reads
          the numbers first and panics. */}
      <div className="mb-5 rounded-lg border border-info/30 bg-info-bg px-4 py-3 text-sm text-info-ink">
        <strong>USD = API-list-price equivalent.</strong> You're on subscription
        auth — Anthropic charges your flat plan, not this number. Use it as a
        consumption proxy. Rates snapshot: <code>{data.ratesVersion}</code>.
      </div>

      {/* Header KPIs */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <Card>
          <div className="text-xs uppercase text-ink-faint">Tokens ({data.days}d)</div>
          <div className="mt-1 text-2xl font-semibold text-ink">
            {formatBig(totalTokens)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Sessions ({data.days}d)</div>
          <div className="mt-1 text-2xl font-semibold text-ink">
            {totalSessions.toLocaleString()}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Est. cost ({data.days}d)</div>
          <div className="mt-1 text-2xl font-semibold text-ink">
            {formatUsd(data.totalUsd)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Monthly projection</div>
          <div className="mt-1 text-2xl font-semibold text-ink">
            {formatUsd(data.monthlyProjectionUsd)}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            7-day rolling × 30/7
          </div>
        </Card>
      </div>

      {/* Daily bars */}
      <Card className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-ink">Daily tokens</div>
            <div className="text-xs text-ink-faint">
              Last {data.days} days, operator timezone
            </div>
          </div>
          <div className="flex gap-1 text-xs">
            {[14, 30].map((n) => (
              <button
                key={n}
                onClick={() => setDays(n as 14 | 30)}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  days === n
                    ? 'bg-accent-bg text-accent-ink'
                    : 'bg-surface-muted text-ink-dim hover:text-ink'
                }`}
              >
                {n}d
              </button>
            ))}
          </div>
        </div>
        <DailyTokensBar data={data.daily} height={260} />
      </Card>

      {/* Per-model split */}
      <Card>
        <div className="mb-3 text-sm font-semibold text-ink">Per model</div>
        {data.perModel.length === 0 ? (
          <div className="rounded border border-dashed border-line bg-surface-muted px-4 py-6 text-center text-sm text-ink-faint">
            No usage recorded in this window. DM your bot to get started.
          </div>
        ) : (
          <div className="grid grid-cols-[220px_1fr] gap-6">
            <ModelDonut
              data={data.perModel.map((m) => ({
                model: m.model ?? 'unknown',
                tokens: m.tokensIn + m.tokensOut,
              }))}
            />
            <div className="min-w-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-ink-faint">
                    <th className="pb-2 pr-4 font-medium">Model</th>
                    <th className="pb-2 pr-4 font-medium">Sessions</th>
                    <th className="pb-2 pr-4 font-medium">Tokens in/out</th>
                    <th className="pb-2 pr-4 font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perModel.map((m, i) => (
                    <tr key={m.model ?? 'unknown'} className="border-t border-line">
                      <td className="py-2 pr-4">
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{
                              background:
                                SLICE_COLORS[i % SLICE_COLORS.length],
                            }}
                          />
                          <span className="font-mono text-xs text-ink">
                            {m.model ?? 'unknown'}
                          </span>
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-ink">
                        {m.sessions.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-xs text-ink-dim">
                        {formatBig(m.tokensIn)} / {formatBig(m.tokensOut)}
                      </td>
                      <td className="py-2 pr-4 text-ink">
                        {formatUsd(estimateUsd(m.model, m.tokensIn, m.tokensOut))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {data.perModel.length === 0 && (
        <div className="mt-5">
          <Badge tone="info">Need ≥3 days of history</Badge>
          <span className="ml-2 text-sm text-ink-dim">
            Monthly projection shows — until the service has accumulated enough
            usage for a stable 7-day rolling window.
          </span>
        </div>
      )}
    </div>
  );
}

/** Compact format for large token counts: 1.2M / 12k. */
function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}
