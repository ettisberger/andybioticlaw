import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiGet, formatTs } from '../lib/api';
import { Badge, Card, ErrorBanner, PageTitle } from '../components/ui';

interface SessionDetail {
  session: {
    id: string;
    status: string;
    source: string;
    source_ref: string | null;
    started_at: number;
    ended_at: number | null;
    tokens_input: number;
    tokens_output: number;
    error: string | null;
    model: string | null;
    input_preview: string | null;
  };
  messages: Array<{
    id: number;
    role: string;
    content: string;
    created_at: number;
  }>;
}

interface LiveSession {
  sessionId: string;
  chatId: string;
  source: string;
  startedAt: number;
  lastDeltaAt: number | null;
  text: string;
  toolUses: string[];
  truncated: boolean;
}

const SESSION_POLL_MS = 5000;
const LIVE_POLL_MS = 2000;

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSession | null>(null);

  useEffect(() => {
    if (!id) return;
    let stopped = false;
    async function fetchOnce() {
      try {
        const d = await apiGet<SessionDetail>(`/api/sessions/${id}`);
        if (!stopped) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }
    fetchOnce();
    // Slow poll so a running session transitions to completed without a
    // manual refresh. Stops itself below once status is terminal.
    const h = setInterval(() => {
      if (!data || data.session.status === 'running') fetchOnce();
    }, SESSION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Fast poll for mid-stream state, only while the session is running.
  useEffect(() => {
    if (!id) return;
    if (data?.session.status && data.session.status !== 'running') {
      setLive(null);
      return;
    }
    let stopped = false;
    async function tick() {
      try {
        const r = await apiGet<{ live: LiveSession }>(`/api/sessions/${id}/live`);
        if (!stopped) setLive(r.live);
      } catch {
        // 404 is expected once the session finishes — clear the live pane.
        if (!stopped) setLive(null);
      }
    }
    tick();
    const h = setInterval(tick, LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, [id, data?.session.status]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-ink-dim">loading…</div>;

  const { session, messages } = data;
  const isRunning = session.status === 'running';

  return (
    <div>
      <Link to="/sessions" className="mb-2 inline-block text-xs text-ink-dim hover:text-ink">
        ← back to sessions
      </Link>
      <PageTitle subtitle={`${session.source} · model ${session.model ?? '—'}`}>
        <span className="font-mono">{session.id.slice(0, 12)}…</span>
      </PageTitle>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card>
          <div className="text-xs uppercase text-ink-faint">Status</div>
          <div className="mt-1"><Badge tone={statusTone(session.status)}>{session.status}</Badge></div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Tokens</div>
          <div className="mt-1">
            {session.tokens_input.toLocaleString()} in / {session.tokens_output.toLocaleString()} out
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-ink-faint">Timing</div>
          <div className="mt-1 text-xs">{formatTs(session.started_at)}</div>
          <div className="text-xs text-ink-faint">
            {session.ended_at ? `ended ${formatTs(session.ended_at)}` : '(still active)'}
          </div>
        </Card>
      </div>

      {session.error && (
        <div className="mb-4 rounded border border-error/30 bg-error-bg px-3 py-2 text-sm text-error-ink">
          <span className="font-medium">error:</span> {session.error}
        </div>
      )}

      {isRunning && <LivePanel live={live} />}

      <Card>
        <div className="mb-2 text-sm font-medium text-ink">Messages in this chat</div>
        {messages.length === 0 && <div className="text-sm text-ink-faint">(no messages)</div>}
        <div className="space-y-2">
          {messages.map((m) => (
            <div key={m.id} className="rounded border border-line bg-surface-muted p-2">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <Badge tone={m.role === 'user' ? 'accent' : 'neutral'}>{m.role}</Badge>
                <span className="text-ink-faint">{formatTs(m.created_at)}</span>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-ink">{m.content}</pre>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function LivePanel({ live }: { live: LiveSession | null }) {
  // Ticks every second so elapsed/since-delta stay fresh between polls.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        Live
      </div>
      {!live ? (
        <div className="text-xs text-ink-faint">waiting for first delta…</div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-ink-dim">
            <span>{Math.max(0, Math.floor((now - live.startedAt) / 1000))}s elapsed</span>
            {live.lastDeltaAt != null && (
              <span>
                last delta {Math.max(0, Math.floor((now - live.lastDeltaAt) / 1000))}s ago
              </span>
            )}
            <span>
              {live.toolUses.length} tool call{live.toolUses.length === 1 ? '' : 's'}
            </span>
          </div>
          {live.toolUses.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {live.toolUses.map((t, i) => (
                <span
                  key={i}
                  className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface-muted p-2 text-xs text-ink">
            {live.text || '(no output yet)'}
          </pre>
          {live.truncated && (
            <div className="mt-1 text-[10px] text-ink-faint">
              (output truncated — older chars dropped; full text will be recorded on completion)
            </div>
          )}
        </>
      )}
    </Card>
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
