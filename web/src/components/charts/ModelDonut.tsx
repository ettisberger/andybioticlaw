import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export interface ModelSlice {
  model: string;
  tokens: number;
}

interface Props {
  data: ModelSlice[];
  height?: number;
}

// Palette maps to the Tailwind CSS variables; cycled in order for slices
// sorted descending by tokens.
const SLICE_COLORS = [
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-warn)',
  'var(--color-info)',
  'var(--color-error)',
  'var(--color-ink-dim)',
];

/**
 * Donut chart of per-model token distribution. Model labels live alongside
 * this component (legend is rendered externally to save chart real estate).
 */
export function ModelDonut({ data, height = 220 }: Props) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line bg-surface-muted text-sm text-ink-faint"
        style={{ height }}
      >
        No usage recorded in this window.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="tokens"
          nameKey="model"
          innerRadius="55%"
          outerRadius="85%"
          paddingAngle={2}
          stroke="var(--color-surface)"
          strokeWidth={2}
        >
          {data.map((entry, index) => (
            <Cell
              key={entry.model}
              fill={SLICE_COLORS[index % SLICE_COLORS.length]}
            />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-line-strong)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-ink)',
          }}
          formatter={(v, _name, ctx) => [
            formatTokens(Number(v) || 0),
            (ctx as { payload?: ModelSlice }).payload?.model ?? '',
          ]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Exported so StatsPage can render the same palette in its legend. */
export { SLICE_COLORS };
