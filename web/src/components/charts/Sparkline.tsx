/**
 * Tiny hand-rolled SVG sparkline — no chart-library dep, ~30 lines.
 * Used in the Overview teaser so that page stays light; the full-fat
 * chart library (Recharts) is lazy-loaded with StatsPage.
 */
interface Props {
  data: number[];
  height?: number;
  width?: number;
}

export function Sparkline({ data, height = 48, width = 280 }: Props) {
  if (data.length === 0) return <div style={{ height, width }} />;
  const max = Math.max(...data, 1); // avoid /0
  const n = data.length;
  const barW = width / n;
  const gap = Math.max(1, barW * 0.1);
  return (
    <svg width={width} height={height} role="img" aria-label="14-day usage sparkline">
      {data.map((v, i) => {
        const h = Math.max(v === 0 ? 0 : 2, (v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * barW + gap / 2}
            y={height - h}
            width={barW - gap}
            height={h}
            rx={1}
            fill="var(--color-accent)"
          />
        );
      })}
    </svg>
  );
}
