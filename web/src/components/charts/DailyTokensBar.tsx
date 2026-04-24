import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface DailyBucket {
  date: string; // YYYY-MM-DD
  tokens: number;
}

interface Props {
  data: DailyBucket[];
  height?: number;
  /** If true, hides axes + tooltip — use for the Overview sparkline. */
  compact?: boolean;
}

/**
 * Bar chart of tokens per day, themed with the dashboard's Tailwind
 * CSS variables. Compact mode drops axes for a sparkline fit.
 */
export function DailyTokensBar({ data, height = 240, compact = false }: Props) {
  if (compact) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <Bar dataKey="tokens" fill="var(--color-accent)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-line)" />
        <XAxis
          dataKey="date"
          // Show only MM-DD for brevity (strip YYYY-).
          tickFormatter={(v: string) => v.slice(5)}
          tick={{ fill: 'var(--color-ink-faint)', fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: 'var(--color-line)' }}
        />
        <YAxis
          tick={{ fill: 'var(--color-ink-faint)', fontSize: 11 }}
          tickFormatter={formatTokens}
          tickLine={false}
          axisLine={{ stroke: 'var(--color-line)' }}
          width={48}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-surface-muted)' }}
          contentStyle={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-line-strong)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-ink)',
          }}
          formatter={(v) => [formatTokens(Number(v) || 0), 'tokens']}
        />
        <Bar dataKey="tokens" fill="var(--color-accent)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
