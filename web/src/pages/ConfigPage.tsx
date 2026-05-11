import { useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  Activity,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  History,
  MessageCircle,
  Monitor,
  Puzzle,
  Route,
  Settings as SettingsIcon,
  Wallet,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';
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
      {sections.map(([sectionKey, sectionValue]) => {
        const Custom = CUSTOM_RENDERERS[sectionKey];
        if (Custom) {
          return <Custom key={sectionKey} value={sectionValue} />;
        }
        return (
          <SectionCard
            key={sectionKey}
            path={sectionKey}
            title={sectionKey}
            value={sectionValue}
            hotReloadable={hotReloadable}
            restartRequired={restartRequired}
          />
        );
      })}
    </div>
  );
}

// ─── custom section renderers ─────────────────────────────────────────
//
// Some top-level config sections (notably `agents` — an array of nested
// objects) render badly through the generic `flattenSection` pipeline.
// The registry lets us hand-render those without forking the whole
// CardsView. Sections without an entry fall through to SectionCard.

interface CustomSectionProps {
  value: unknown;
}

const CUSTOM_RENDERERS: Record<string, ComponentType<CustomSectionProps>> = {
  agents: AgentsConfigSection,
  bindings: BindingsConfigSection,
};

interface AgentEntry {
  id: string;
  name: string;
  default?: boolean;
  model: string;
  haikuModel: string;
  skills: string[];
  routing?: { enabled: boolean; minCharsForOpus: number };
}

function AgentsConfigSection({ value }: CustomSectionProps) {
  const agents = (Array.isArray(value) ? value : []) as AgentEntry[];
  return (
    <Card>
      <SectionHeader
        icon={Bot}
        title="Agents"
        subtitle="Each entry is a Claude Code persona. Exactly one is the default; bindings (below) decide which non-default agents handle which messages."
      />
      {agents.length === 0 ? (
        <div className="text-sm text-ink-faint">No agents configured.</div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Default</Th>
              <Th>Id</Th>
              <Th>Name</Th>
              <Th>Model</Th>
              <Th>Cheap fallback</Th>
              <Th>Router</Th>
              <Th>Skills</Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="hover:bg-surface-muted/50">
                <Td>{a.default ? <Badge tone="accent">default</Badge> : null}</Td>
                <Td className="font-mono text-xs text-info-ink">{a.id}</Td>
                <Td className="text-sm font-medium text-ink">{a.name}</Td>
                <Td className="font-mono text-xs text-ink-dim">{a.model}</Td>
                <Td className="font-mono text-xs text-ink-faint">{a.haikuModel}</Td>
                <Td>
                  {a.routing?.enabled ? (
                    <span className="flex items-center gap-2">
                      <Badge tone="success">on</Badge>
                      <span className="text-xs text-ink-faint">
                        ≥{a.routing.minCharsForOpus} chars → Opus
                      </span>
                    </span>
                  ) : (
                    <Badge tone="neutral">off</Badge>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.skills.map((s) => (
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
    </Card>
  );
}

interface BindingEntry {
  agentId: string;
  match: {
    channel: string;
    chatIds?: number[];
    userIds?: number[];
  };
}

const BINDINGS_EXAMPLE = `bindings:
  - agentId: work
    match:
      channel: telegram
      userIds: [123456789]   # DMs from this Telegram user → work agent
  - agentId: research
    match:
      channel: telegram
      chatIds: [-1009876543210]   # this group chat → research agent`;

function BindingsConfigSection({ value }: CustomSectionProps) {
  const bindings = (Array.isArray(value) ? value : []) as BindingEntry[];
  const [showExample, setShowExample] = useState(false);

  return (
    <Card>
      <SectionHeader
        icon={Route}
        title="Bindings"
        subtitle="Routing rules — match incoming messages to a specific agent. Most-specific rule wins (chatId+userId > chatId > userId > channel). No match → the default agent."
      />
      {bindings.length === 0 ? (
        <div className="space-y-3 text-sm">
          <div className="text-ink-dim">
            <span className="text-ink-faint">∅ no rules</span> — every message
            routes to the default agent above.
          </div>
          <button
            type="button"
            onClick={() => setShowExample((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-accent-ink hover:underline"
          >
            {showExample ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {showExample ? 'Hide example' : 'Show example rule'}
          </button>
          {showExample && (
            <pre className="overflow-auto rounded-md bg-surface-muted/60 p-3 font-mono text-xs leading-relaxed text-ink-dim">
              {BINDINGS_EXAMPLE}
            </pre>
          )}
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Agent</Th>
              <Th>Channel</Th>
              <Th>Chat IDs</Th>
              <Th>User IDs</Th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((b, i) => (
              <tr key={i} className="hover:bg-surface-muted/50">
                <Td>
                  <Badge tone="accent">{b.agentId}</Badge>
                </Td>
                <Td className="font-mono text-xs text-ink-dim">{b.match.channel}</Td>
                <Td>
                  <IdList ids={b.match.chatIds} />
                </Td>
                <Td>
                  <IdList ids={b.match.userIds} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function IdList({ ids }: { ids: number[] | undefined }) {
  if (!ids || ids.length === 0) {
    return <span className="text-xs text-ink-faint">any</span>;
  }
  const head = ids.slice(0, 3);
  const rest = ids.length - head.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {head.map((id) => (
        <code
          key={id}
          className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[11px] tabular-nums text-ink-dim"
        >
          {id}
        </code>
      ))}
      {rest > 0 && (
        <span className="text-[11px] text-ink-faint">+{rest} more</span>
      )}
    </span>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-bg text-accent-ink">
          <Icon size={16} strokeWidth={2} />
        </span>
        <h2 className="text-base font-semibold capitalize tracking-tight text-ink">
          {title}
        </h2>
      </div>
      {subtitle && (
        <div className="mt-1.5 pl-[42px] text-xs leading-snug text-ink-faint">
          {subtitle}
        </div>
      )}
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

  const description = FIELD_DESCRIPTIONS[row.path];

  return (
    <div>
      <div
        className="flex items-center gap-3 py-1 text-sm"
        style={{ paddingLeft: `${row.depth * 12}px` }}
      >
        <span className="min-w-[180px] text-ink-dim">{humanizeKey(row.label)}</span>
        <span className="flex-1">{renderValue(row.value, row.path)}</span>
        {tag && <span className="shrink-0">{tag}</span>}
      </div>
      {description && (
        <div
          className="pb-1 text-xs leading-snug text-ink-faint"
          style={{ paddingLeft: `${row.depth * 12 + 180 + 12}px` }}
        >
          {description}
        </div>
      )}
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

/**
 * One-line plain-English explanation for fields whose schema names
 * aren't self-explanatory. Rendered dim under the value in FieldRow.
 * Keep entries terse — the goal is "operator opens dashboard, gets
 * the gist without reading source".
 */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  'observability.heartbeatIntervalSec':
    'How often the service writes a liveness snapshot. Powers the Sessions / live-state widgets.',
  'observability.heartbeatRetentionDays':
    'How long to keep those snapshots before the daily cleanup prunes them.',
  'observability.errorsToTelegram':
    'When on: every internal service error is DM’d to the principal so crashes surface immediately.',
  'observability.errorChatIdOverride':
    'If set, error DMs go here instead of the principal’s chat (e.g. a private admin group id).',
  'telegram.statusMessage.enabled':
    'When on: send a one-line "🤖 online" notification to the principal chat after every boot. Useful as a deploy-completion ping.',
  'telegram.statusMessage.agentId':
    'Which agent name appears in the bold header. Defaults to the default agent.',
  'projects.enabled':
    'When on: scan `folderPath` for git repos and show them on the dashboard /projects page. Adds a "Projects" sidebar link.',
  'projects.folderPath':
    'Folder containing one subdir per project. Symlinks are followed. Defaults to ~/projects.',
  'projects.staleDays':
    'Repos with no commits in this many days are flagged "stale" (90 = ~3 months). Beyond 6× this value the badge becomes "inactive".',
};

function numberSuffix(path: string): string | null {
  const last = lastSegment(path).toLowerCase();
  // Order matters — more-specific matches must come first.
  if (last.endsWith('ms')) return 'ms';
  if (last.endsWith('sec')) return 's';
  if (last.endsWith('days')) return 'days';
  if (last.includes('port')) return null;
  if (last.includes('historylimit')) return 'msgs';
  if (last.includes('retentiondays')) return null; // already 'days' via endsWith
  if (last.includes('tokenlimit') || last.includes('tokens') || last.includes('schedulledefault')) {
    return 'tokens';
  }
  // Generic `limit` fallback — catches budget.dailyTokenLimit etc. AFTER
  // the specific 'historylimit' + 'retentiondays' checks above.
  if (last.includes('limit') || last.includes('default')) {
    return 'tokens';
  }
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
  agents: Bot,
  bindings: Route,
  telegram: MessageCircle,
  budget: Wallet,
  memory: Brain,
  messages: History,
  dashboard: Monitor,
  observability: Activity,
  skills: Puzzle,
};
