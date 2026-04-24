import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Bot,
  Brain,
  Clock,
  History,
  MessageCircle,
  Monitor,
  Puzzle,
  Settings as SettingsIcon,
  Wallet,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle } from '../components/ui';
import { humanizeCron } from './config/cron-translate';

const VIEW_KEY = 'abl_config_view';

interface ConfigResponse {
  config: Record<string, unknown>;
  hotReloadable: string[];
  restartRequired: string[];
}

type ViewMode = 'cards' | 'json';

export function ConfigPage() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'cards';
    const stored = window.localStorage.getItem(VIEW_KEY);
    return stored === 'json' ? 'json' : 'cards';
  });

  useEffect(() => {
    apiGet<ConfigResponse>('/api/config').then(setData).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode — fine */
    }
  }, [view]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;

  return (
    <div>
      <PageTitle subtitle="Read-only snapshot. Edit via the CLI: andybioticlaw settings.">
        <span className="flex items-center justify-between gap-4">
          <span>Config</span>
          <ViewToggle view={view} onChange={setView} />
        </span>
      </PageTitle>
      {data === null ? (
        <div className="text-ink-dim">loading…</div>
      ) : view === 'json' ? (
        <JsonView config={data.config} />
      ) : (
        <CardsView
          config={data.config}
          hotReloadable={new Set(data.hotReloadable)}
          restartRequired={new Set(data.restartRequired)}
        />
      )}
    </div>
  );
}

// ─── top-right segmented switcher ─────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <span className="inline-flex rounded-lg border border-line/60 bg-surface/50 p-0.5 backdrop-blur-sm">
      {(['cards', 'json'] as const).map((v) => {
        const selected = v === view;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              selected
                ? 'bg-accent-bg text-accent-ink'
                : 'text-ink-dim hover:text-ink'
            }`}
          >
            {v === 'cards' ? 'Cards' : '{ JSON }'}
          </button>
        );
      })}
    </span>
  );
}

// ─── json view ────────────────────────────────────────────────────────

function JsonView({ config }: { config: unknown }) {
  return (
    <Card>
      <pre className="overflow-auto font-mono text-xs leading-relaxed text-ink">
        {JSON.stringify(config, null, 2)}
      </pre>
    </Card>
  );
}

// ─── cards view (one Card per top-level section) ──────────────────────

interface CardsViewProps {
  config: Record<string, unknown>;
  hotReloadable: Set<string>;
  restartRequired: Set<string>;
}

function CardsView({ config, hotReloadable, restartRequired }: CardsViewProps) {
  // Render in the order the sections appear in the config object.
  // Object.entries preserves insertion order for string keys in modern JS.
  const sections = useMemo(() => Object.entries(config), [config]);

  return (
    <div className="space-y-4">
      {sections.map(([sectionKey, sectionValue]) => (
        <SectionCard
          key={sectionKey}
          path={sectionKey}
          title={sectionKey}
          value={sectionValue}
          hotReloadable={hotReloadable}
          restartRequired={restartRequired}
        />
      ))}
    </div>
  );
}

// ─── one top-level section card ───────────────────────────────────────

function SectionCard(props: {
  path: string;
  title: string;
  value: unknown;
  hotReloadable: Set<string>;
  restartRequired: Set<string>;
}) {
  const Icon = SECTION_ICONS[props.path] ?? SettingsIcon;
  const rows = flattenSection(props.path, props.value);

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-bg text-accent-ink">
          <Icon size={16} strokeWidth={2} />
        </span>
        <h2 className="text-base font-semibold capitalize tracking-tight text-ink">
          {humanizeKey(props.title)}
        </h2>
      </div>
      <div className="space-y-1">
        {rows.map((row) => (
          <FieldRow
            key={row.path}
            row={row}
            hotReloadable={props.hotReloadable}
            restartRequired={props.restartRequired}
          />
        ))}
      </div>
    </Card>
  );
}

// ─── one field row ────────────────────────────────────────────────────

interface FlatRow {
  kind: 'field' | 'subheader';
  path: string;
  label: string;
  depth: number;
  value?: unknown;
}

function FieldRow({
  row,
  hotReloadable,
  restartRequired,
}: {
  row: FlatRow;
  hotReloadable: Set<string>;
  restartRequired: Set<string>;
}) {
  if (row.kind === 'subheader') {
    return (
      <div
        className="mt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint"
        style={{ paddingLeft: `${row.depth * 12}px` }}
      >
        {humanizeKey(row.label)}
      </div>
    );
  }

  const restart = restartRequired.has(row.path);
  const live = hotReloadable.has(row.path);
  // Every restart-tagged path gets the yellow chip; hot-reloadable gets
  // green; fields not in either list (things like `service.name` that
  // aren't really tunable at runtime) get no chip to reduce noise.
  const tag = restart ? (
    <ReloadTag tone="warn">restart</ReloadTag>
  ) : live ? (
    <ReloadTag tone="success">live</ReloadTag>
  ) : null;

  return (
    <div
      className="flex items-center gap-3 py-1 text-sm"
      style={{ paddingLeft: `${row.depth * 12}px` }}
    >
      <span className="min-w-[180px] text-ink-dim">{humanizeKey(row.label)}</span>
      <span className="flex-1">{renderValue(row.value, row.path)}</span>
      {tag && <span className="shrink-0">{tag}</span>}
    </div>
  );
}

function ReloadTag({ tone, children }: { tone: 'success' | 'warn'; children: ReactNode }) {
  const classes =
    tone === 'success'
      ? 'bg-success-bg text-success-ink'
      : 'bg-warn-bg text-warn-ink';
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ${classes}`}>
      {children}
    </span>
  );
}

// ─── value rendering by type ──────────────────────────────────────────

function renderValue(value: unknown, path: string): ReactNode {
  if (value === null || value === undefined) {
    // Context-aware null: retention = "forever", schedule overrides = "never", …
    const label = NULL_LABELS[path] ?? '—';
    return <span className="text-ink-faint">{label}</span>;
  }
  if (typeof value === 'boolean') {
    return value ? (
      <Badge tone="success">✓ On</Badge>
    ) : (
      <Badge tone="neutral">○ Off</Badge>
    );
  }
  if (typeof value === 'number') {
    return <NumberValue path={path} value={value} />;
  }
  if (typeof value === 'string') {
    return <StringValue path={path} value={value} />;
  }
  if (Array.isArray(value)) {
    return <ArrayValue value={value} />;
  }
  // Nested objects are handled by flattenSection — we never hit this.
  return <span className="font-mono text-ink-dim">{JSON.stringify(value)}</span>;
}

function NumberValue({ path, value }: { path: string; value: number }) {
  const suffix = numberSuffix(path);
  return (
    <span className="font-mono tabular-nums text-ink">
      {value.toLocaleString()}
      {suffix && <span className="ml-1 text-ink-faint">{suffix}</span>}
    </span>
  );
}

function StringValue({ path, value }: { path: string; value: string }) {
  // Secret — already masked by the backend ([REDACTED]).
  if (value === '[REDACTED]') {
    return <Badge tone="warn">••• redacted</Badge>;
  }
  // Enum-ish values get coloured pills.
  const tone = enumTone(path, value);
  if (tone) return <Badge tone={tone}>{value}</Badge>;
  // Cron — show raw + humanised translation.
  if (isCronField(path)) {
    const translated = humanizeCron(value);
    return (
      <span>
        <span className="font-mono text-ink">{value}</span>
        {translated && (
          <span className="ml-2 text-xs text-ink-faint">({translated})</span>
        )}
      </span>
    );
  }
  // Time of day (HH:MM) — clock icon.
  if (/^\d{2}:\d{2}$/.test(value)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink">
        <Clock size={12} strokeWidth={2} className="text-ink-faint" />
        <span className="font-mono tabular-nums">{value}</span>
      </span>
    );
  }
  // Paths — mono.
  if (
    value.startsWith('./') ||
    value.startsWith('/') ||
    value.startsWith('~')
  ) {
    return <span className="font-mono text-ink">{value}</span>;
  }
  return <span className="text-ink">{value}</span>;
}

function ArrayValue({ value }: { value: unknown[] }) {
  if (value.length === 0) {
    return <span className="text-ink-faint">∅ empty</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {value.map((v, i) => (
        <span
          key={i}
          className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink-dim"
        >
          {typeof v === 'string' ? v : JSON.stringify(v)}
        </span>
      ))}
    </span>
  );
}

// ─── field-shape heuristics ───────────────────────────────────────────

function flattenSection(rootPath: string, value: unknown): FlatRow[] {
  const out: FlatRow[] = [];
  walk(value, rootPath, rootPath, 0);
  return out;

  function walk(v: unknown, path: string, label: string, depth: number) {
    // Skip the rootPath itself — its content is what we iterate.
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      out.push({
        kind: 'field',
        path,
        label: lastSegment(label),
        depth,
        value: v,
      });
      return;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    // Separate scalar + array children from nested-object children so
    // the rendering order is: scalars first, then subheaders.
    const scalars = entries.filter(([, val]) => !isPlainObject(val));
    const nested = entries.filter(([, val]) => isPlainObject(val));

    if (depth === 0) {
      for (const [k, val] of scalars) {
        walk(val, `${path}.${k}`, k, depth);
      }
      for (const [k, val] of nested) {
        out.push({
          kind: 'subheader',
          path: `${path}.${k}`,
          label: k,
          depth: depth + 1,
        });
        walk(val, `${path}.${k}`, k, depth + 1);
      }
      return;
    }

    for (const [k, val] of scalars) {
      walk(val, `${path}.${k}`, k, depth);
    }
    for (const [k, val] of nested) {
      out.push({
        kind: 'subheader',
        path: `${path}.${k}`,
        label: k,
        depth: depth + 1,
      });
      walk(val, `${path}.${k}`, k, depth + 1);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// ─── label humanisation ───────────────────────────────────────────────

function humanizeKey(key: string): string {
  // camelCase / dotted → Title Case words.
  return key
    .replace(/\./g, ' · ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// ─── per-type heuristics ──────────────────────────────────────────────

const NULL_LABELS: Record<string, string> = {
  'messages.retentionDays': 'forever',
  'observability.errorChatIdOverride': 'default chat',
};

function numberSuffix(path: string): string | null {
  const last = lastSegment(path).toLowerCase();
  if (last.endsWith('ms')) return 'ms';
  if (last.endsWith('sec')) return 's';
  if (last.endsWith('days')) return 'days';
  if (last.includes('port')) return null;
  if (last.includes('limit') || last.includes('tokens') || last.includes('default')) {
    return 'tokens';
  }
  if (last.includes('historylimit')) return 'msgs';
  return null;
}

function isCronField(path: string): boolean {
  return path.endsWith('Cron') || path.endsWith('cronExpr') || path.endsWith('cleanupCron');
}

function enumTone(
  path: string,
  value: string,
): 'success' | 'warn' | 'error' | 'accent' | 'info' | 'neutral' | null {
  const last = lastSegment(path);
  if (last === 'logLevel') {
    if (value === 'debug') return 'info';
    if (value === 'info') return 'neutral';
    if (value === 'warn') return 'warn';
    if (value === 'error') return 'error';
  }
  if (last === 'runMode') return 'accent';
  if (last === 'model') return 'accent';
  if (last === 'allowedTools') return value === 'all' ? 'warn' : 'accent';
  return null;
}

// ─── section icons ────────────────────────────────────────────────────

const SECTION_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  service: SettingsIcon,
  agent: Bot,
  telegram: MessageCircle,
  budget: Wallet,
  memory: Brain,
  messages: History,
  dashboard: Monitor,
  observability: Activity,
  skills: Puzzle,
};
