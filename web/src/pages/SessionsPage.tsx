import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiDelete, apiGet, apiPost, formatTs, truncate } from '../lib/api';
import { Badge, Button, ErrorBanner, PageTitle, Table, Td, Th, Empty } from '../components/ui';
import { estimateUsd, formatUsd } from '../lib/pricing';
import { formatModelLabel, modelTone } from '../lib/model-label';

/**
 * Sessions that are still in flight cannot be deleted (server refuses
 * with 409). The UI hides the checkbox + per-row delete on these statuses
 * so the user doesn't try and get a confusing error.
 */
const DELETABLE_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'crashed',
  'orphaned',
]);

interface SessionRow {
  id: string;
  source: string;
  source_ref: string | null;
  status: string;
  input_preview: string | null;
  started_at: number;
  ended_at: number | null;
  tokens_input: number;
  tokens_output: number;
  error: string | null;
  model: string | null;
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

const LIVE_POLL_MS = 2000;

const FILTERS: Array<{ label: string; status?: string }> = [
  { label: 'All' },
  { label: 'Running', status: 'running' },
  { label: 'Completed', status: 'completed' },
  { label: 'Failed', status: 'failed' },
  { label: 'Crashed', status: 'crashed' },
  { label: 'Orphaned', status: 'orphaned' },
  { label: 'Cancelled', status: 'cancelled' },
];

export function SessionsPage() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSession[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const qs = filter ? `?status=${encodeURIComponent(filter)}&limit=100` : '?limit=100';
      const data = await apiGet<{ sessions: SessionRow[] }>(`/api/sessions${qs}`);
      setRows(data.sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Drop ids from `selectedIds` that no longer appear in `rows` so a stale
  // selection (e.g. after a filter change) doesn't bulk-delete invisible rows.
  const visibleSelectedCount = useMemo(() => {
    const visibleIds = new Set(rows.map((r) => r.id));
    let n = 0;
    for (const id of selectedIds) if (visibleIds.has(id)) n++;
    return n;
  }, [rows, selectedIds]);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    const deletable = rows.filter((r) => DELETABLE_STATUSES.has(r.status));
    const allSelected = deletable.every((r) => selectedIds.has(r.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const r of deletable) next.delete(r.id);
      } else {
        for (const r of deletable) next.add(r.id);
      }
      return next;
    });
  }

  async function handleDelete(id: string) {
    if (!window.confirm(`Permanently delete session ${id.slice(0, 8)}…?\n\nThis also removes its messages and any related memory proposals / pending email sends.`)) {
      return;
    }
    try {
      const r = await apiDelete<{
        ok: true;
        messages: number;
        proposals: number;
        emailSends: number;
      }>(`/api/sessions/${id}`);
      const extras: string[] = [];
      if (r.messages > 0) extras.push(`${r.messages} message${r.messages === 1 ? '' : 's'}`);
      if (r.proposals > 0) extras.push(`${r.proposals} proposal${r.proposals === 1 ? '' : 's'}`);
      if (r.emailSends > 0) extras.push(`${r.emailSends} email send${r.emailSends === 1 ? '' : 's'}`);
      const tail = extras.length > 0 ? ` (+ ${extras.join(', ')})` : '';
      setRetryMsg(`deleted ${id.slice(0, 8)}…${tail}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
    } catch (e) {
      const err = e as ApiError;
      setRetryMsg(
        `delete failed: ${(err.body as { error?: string } | null)?.error ?? err.message}`,
      );
    }
  }

  async function handleBulkDelete() {
    const ids = rows.filter((r) => selectedIds.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} session${ids.length === 1 ? '' : 's'}?\n\nThis also removes their messages and any related memory proposals / pending email sends.`)) {
      return;
    }
    try {
      const r = await apiDelete<{
        deleted: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
        notFound: string[];
      }>(`/api/sessions`, { ids });
      const parts: string[] = [`deleted ${r.deleted.length}`];
      if (r.skipped.length > 0) parts.push(`skipped ${r.skipped.length}`);
      if (r.notFound.length > 0) parts.push(`${r.notFound.length} already gone`);
      setRetryMsg(parts.join(', '));
      setSelectedIds(new Set());
      await load();
    } catch (e) {
      setRetryMsg(`bulk delete failed: ${(e as Error).message}`);
    }
  }

  useEffect(() => {
    load();
    // Intentionally don't poll the list — it would jump around while the
    // user reads. Live-now section polls separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Separate poll for the in-flight sessions — short interval so "what is
  // Emma doing right now" feels live. Doesn't reorder the main list.
  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const data = await apiGet<{ live: LiveSession[] }>('/api/sessions/live');
        if (!stopped) setLive(data.live);
      } catch {
        // Transient errors are non-fatal — the live section just goes empty
        // briefly. Don't wire into the error banner (would hide real issues).
      }
    }
    tick();
    const h = setInterval(tick, LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, []);

  async function handleRetry(id: string) {
    setRetryMsg(null);
    try {
      const r = await apiPost<{ sessionId?: string; error?: string; userMessage?: string }>(
        `/api/sessions/${id}/retry`,
      );
      if (r.sessionId) {
        setRetryMsg(`retry dispatched as ${r.sessionId}`);
        await load();
      } else {
        setRetryMsg(`retry refused: ${r.userMessage ?? r.error}`);
      }
    } catch (e) {
      setRetryMsg(`retry failed: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <PageTitle subtitle="All sessions, newest first. Failed/crashed/orphaned rows have a retry button.">
        Sessions
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {retryMsg && (
        <div className="mb-3 rounded border border-info/30 bg-info-bg px-3 py-2 text-sm text-info-ink">
          {retryMsg}
        </div>
      )}

      {live.length > 0 && (
        <div className="mb-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase text-ink-faint">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            Live now ({live.length})
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {live.map((l) => (
              <LiveCard key={l.sessionId} live={l} />
            ))}
          </div>
        </div>
      )}

      <div className="mb-3 flex gap-1.5 flex-wrap items-center">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.status)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium border backdrop-blur-sm ${
              filter === f.status
                ? 'bg-accent-bg border-accent/30 text-accent-ink'
                : 'bg-surface/50 border-line/60 text-ink-dim hover:bg-surface hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
        {visibleSelectedCount > 0 && (
          <Button variant="danger" onClick={() => void handleBulkDelete()}>
            Delete {visibleSelectedCount} selected
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty message="No sessions match this filter." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all deletable sessions"
                  checked={
                    rows.filter((r) => DELETABLE_STATUSES.has(r.status)).length > 0 &&
                    rows
                      .filter((r) => DELETABLE_STATUSES.has(r.status))
                      .every((r) => selectedIds.has(r.id))
                  }
                  onChange={toggleSelectAllVisible}
                />
              </Th>
              <Th>Status</Th>
              <Th>Id</Th>
              <Th>Started</Th>
              <Th>Model</Th>
              <Th>Tokens</Th>
              <Th>Est. cost</Th>
              <Th>Input</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const retriable = ['failed', 'crashed', 'orphaned', 'cancelled'].includes(s.status);
              const deletable = DELETABLE_STATUSES.has(s.status);
              return (
                <tr key={s.id} className="hover:bg-surface-muted/50">
                  <Td>
                    {deletable ? (
                      <input
                        type="checkbox"
                        aria-label={`Select session ${s.id.slice(0, 8)}`}
                        checked={selectedIds.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                      />
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                  </Td>
                  <Td className="font-mono text-xs tabular-nums">
                    <Link to={`/sessions/${s.id}`} className="text-info-ink hover:underline">
                      {s.id.slice(0, 8)}…
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs tabular-nums text-ink-dim">
                    {formatTs(s.started_at)}
                  </Td>
                  <Td>
                    <Badge tone={modelTone(s.model)}>
                      {formatModelLabel(s.model)}
                    </Badge>
                  </Td>
                  <Td className="text-xs tabular-nums">
                    {s.tokens_input.toLocaleString()}/{s.tokens_output.toLocaleString()}
                  </Td>
                  <Td className="text-xs tabular-nums text-ink-dim">
                    {formatUsd(estimateUsd(s.model, s.tokens_input, s.tokens_output))}
                  </Td>
                  <Td className="text-xs text-ink">{truncate(s.input_preview, 80)}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      {retriable && (
                        <Button variant="ghost" onClick={() => handleRetry(s.id)}>
                          retry
                        </Button>
                      )}
                      {deletable && (
                        <Button variant="ghost" onClick={() => void handleDelete(s.id)}>
                          delete
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
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

function LiveCard({ live }: { live: LiveSession }) {
  // Re-render every second so "elapsed" ticks up even between API polls.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - live.startedAt) / 1000));
  const sinceDelta =
    live.lastDeltaAt != null ? Math.max(0, Math.floor((now - live.lastDeltaAt) / 1000)) : null;

  // Show the tail end of the streamed text — that's where the cursor is.
  const tail = live.text.length > 240 ? '…' + live.text.slice(-240) : live.text;

  // Whole card is a link to the detail view — better hit target than just
  // the id, and it gives us a clean surface for the hover/press lift.
  return (
    <Link
      to={`/sessions/${live.sessionId}`}
      className="glass glass-highlight block rounded-2xl p-5 transition-transform hover:-translate-y-0.5 active:translate-y-0"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono tabular-nums text-info-ink">
          {live.sessionId.slice(0, 8)}…
        </span>
        <div className="flex gap-2 text-ink-faint">
          <span>{live.source}</span>
          <span>·</span>
          <span className="tabular-nums">{elapsed}s elapsed</span>
          {sinceDelta !== null && (
            <>
              <span>·</span>
              <span className="tabular-nums">{sinceDelta}s since last delta</span>
            </>
          )}
        </div>
      </div>
      {live.toolUses.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
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
      {tail ? (
        <pre className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-xs text-ink">
          {tail}
        </pre>
      ) : (
        <div className="mt-2 text-xs text-ink-faint">(no output yet)</div>
      )}
    </Link>
  );
}
