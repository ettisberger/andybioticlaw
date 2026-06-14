import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Badge, Empty, ErrorBanner, PageTitle } from '../components/ui';

interface BrowserSessionSummary {
  sessionId: string;
  firstEventMs: number;
  lastEventMs: number;
  eventCount: number;
  profiles: string[];
  okCount: number;
  errorCount: number;
}

interface BrowserEvent {
  id: number;
  sessionId: string;
  profile: string;
  action: string;
  targetUrl: string | null;
  refOrSelector: string | null;
  outcome: string;
  errorMessage: string | null;
  screenshotPath: string | null;
  createdAtMs: number;
}

interface SessionsResp {
  sessions: BrowserSessionSummary[];
  enabled: boolean;
}

interface EventsResp {
  events: BrowserEvent[];
  enabled: boolean;
}

const OUTCOME_TONE: Record<string, 'success' | 'warn' | 'error' | 'neutral'> = {
  ok: 'success',
  blocked: 'warn',
  error: 'error',
};

export function BrowserPage() {
  const [data, setData] = useState<SessionsResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [eventsBySession, setEventsBySession] = useState<
    Record<string, BrowserEvent[]>
  >({});

  async function load() {
    try {
      const d = await apiGet<SessionsResp>('/api/browser/sessions');
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  async function toggleExpanded(sessionId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    if (!eventsBySession[sessionId]) {
      try {
        const r = await apiGet<EventsResp>(
          `/api/browser/sessions/${encodeURIComponent(sessionId)}/events`,
        );
        setEventsBySession((prev) => ({ ...prev, [sessionId]: r.events }));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-ink-dim">loading…</div>;

  if (!data.enabled) {
    return (
      <div>
        <PageTitle subtitle="Activity feed for the browser skill. Disabled in config.">
          Browser
        </PageTitle>
        <Empty message="Browser skill is disabled or its dashboard is off. Set browser.enabled: true and browser.dashboard.enabled: true in config.yaml." />
      </div>
    );
  }

  return (
    <div>
      <PageTitle subtitle="Per-session activity feed. Polled every 15s.">
        Browser
      </PageTitle>

      {data.sessions.length === 0 ? (
        <Empty message="No browser activity yet. Run a session that uses the browser skill." />
      ) : (
        <div className="space-y-2">
          {data.sessions.map((s) => (
            <SessionCard
              key={s.sessionId}
              session={s}
              expanded={expanded.has(s.sessionId)}
              events={eventsBySession[s.sessionId]}
              onToggleExpanded={() => toggleExpanded(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCard({
  session,
  expanded,
  events,
  onToggleExpanded,
}: {
  session: BrowserSessionSummary;
  expanded: boolean;
  events: BrowserEvent[] | undefined;
  onToggleExpanded: () => void;
}) {
  return (
    <div className="glass glass-highlight overflow-hidden rounded-2xl">
      <button
        onClick={onToggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted/50"
      >
        <span className="text-ink-faint">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="text-sm font-mono text-ink">
          {session.sessionId.slice(0, 8)}
        </span>
        <span className="flex gap-1">
          {session.profiles.map((p) => (
            <Badge key={p} tone="info">
              {p}
            </Badge>
          ))}
        </span>
        <span className="text-xs text-ink-dim">
          {session.eventCount} {session.eventCount === 1 ? 'event' : 'events'}
        </span>
        {session.errorCount > 0 && (
          <Badge tone="error">{session.errorCount} err</Badge>
        )}
        <span className="flex-1" />
        <span className="text-xs text-ink-faint">
          {formatRelative(session.lastEventMs)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-line bg-surface-muted/30 px-4 py-4">
          {events === undefined ? (
            <div className="text-xs text-ink-faint">loading events…</div>
          ) : events.length === 0 ? (
            <div className="text-xs text-ink-faint">(no events)</div>
          ) : (
            <ol className="space-y-2">
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: BrowserEvent }) {
  const tone = OUTCOME_TONE[event.outcome] ?? 'neutral';
  return (
    <li className="flex items-start gap-3 text-xs">
      <div className="flex w-20 shrink-0 flex-col">
        <Badge tone={tone}>{event.outcome}</Badge>
        <span className="mt-0.5 text-[10px] text-ink-faint">
          {new Date(event.createdAtMs).toISOString().slice(11, 19)}
        </span>
      </div>
      <div className="flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <code className="font-medium text-ink">{event.action}</code>
          <span className="text-ink-faint">/</span>
          <code className="text-ink-dim">{event.profile}</code>
          {event.refOrSelector && (
            <code className="text-ink-faint">{event.refOrSelector}</code>
          )}
        </div>
        {event.targetUrl && (
          <div className="truncate text-ink-dim" title={event.targetUrl}>
            {event.targetUrl}
          </div>
        )}
        {event.errorMessage && (
          <div className="text-error-ink">{event.errorMessage}</div>
        )}
      </div>
      {event.screenshotPath && (
        <a
          href={`/api/browser/screenshot?path=${encodeURIComponent(event.screenshotPath)}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0"
          title="open screenshot"
        >
          <img
            src={`/api/browser/screenshot?path=${encodeURIComponent(event.screenshotPath)}`}
            alt="screenshot"
            className="h-16 w-24 rounded border border-line object-cover"
            loading="lazy"
          />
        </a>
      )}
    </li>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
