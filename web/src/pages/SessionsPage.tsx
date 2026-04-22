import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, formatTs, truncate } from '../lib/api';
import { Badge, Button, ErrorBanner, PageTitle, Table, Td, Th, Empty } from '../components/ui';

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

  useEffect(() => {
    load();
    // Intentionally don't poll — list would jump around while the user reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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
        <div className="mb-3 rounded border border-sky-800 bg-sky-900/40 px-3 py-2 text-sm text-sky-200">
          {retryMsg}
        </div>
      )}

      <div className="mb-3 flex gap-1.5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.status)}
            className={`rounded px-2.5 py-1 text-xs ${
              filter === f.status
                ? 'bg-slate-600 text-slate-100'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty message="No sessions match this filter." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Status</Th>
              <Th>Id</Th>
              <Th>Started</Th>
              <Th>Tokens</Th>
              <Th>Input</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const retriable = ['failed', 'crashed', 'orphaned', 'cancelled'].includes(s.status);
              return (
                <tr key={s.id} className="hover:bg-slate-800/40">
                  <Td>
                    <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                  </Td>
                  <Td className="font-mono text-xs">
                    <Link to={`/sessions/${s.id}`} className="text-sky-300 hover:underline">
                      {s.id.slice(0, 8)}…
                    </Link>
                  </Td>
                  <Td className="text-xs text-slate-400">{formatTs(s.started_at)}</Td>
                  <Td className="text-xs">
                    {s.tokens_input.toLocaleString()}/{s.tokens_output.toLocaleString()}
                  </Td>
                  <Td className="text-xs text-slate-300">{truncate(s.input_preview, 80)}</Td>
                  <Td>
                    {retriable && (
                      <Button variant="ghost" onClick={() => handleRetry(s.id)}>
                        retry
                      </Button>
                    )}
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
