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

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    apiGet<SessionDetail>(`/api/sessions/${id}`).then(setData).catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!data) return <div className="text-slate-400">loading…</div>;

  const { session, messages } = data;

  return (
    <div>
      <Link to="/sessions" className="mb-2 inline-block text-xs text-slate-400 hover:text-slate-200">
        ← back to sessions
      </Link>
      <PageTitle subtitle={`${session.source} · model ${session.model ?? '—'}`}>
        <span className="font-mono">{session.id.slice(0, 12)}…</span>
      </PageTitle>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card>
          <div className="text-xs uppercase text-slate-500">Status</div>
          <div className="mt-1"><Badge tone={statusTone(session.status)}>{session.status}</Badge></div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Tokens</div>
          <div className="mt-1">
            {session.tokens_input.toLocaleString()} in / {session.tokens_output.toLocaleString()} out
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-slate-500">Timing</div>
          <div className="mt-1 text-xs">{formatTs(session.started_at)}</div>
          <div className="text-xs text-slate-500">
            {session.ended_at ? `ended ${formatTs(session.ended_at)}` : '(still active)'}
          </div>
        </Card>
      </div>

      {session.error && (
        <div className="mb-4 rounded border border-rose-800 bg-rose-900/40 px-3 py-2 text-sm text-rose-200">
          <span className="font-medium">error:</span> {session.error}
        </div>
      )}

      <Card>
        <div className="mb-2 text-sm font-medium text-slate-300">Messages in this chat</div>
        {messages.length === 0 && <div className="text-sm text-slate-500">(no messages)</div>}
        <div className="space-y-2">
          {messages.map((m) => (
            <div key={m.id} className="rounded border border-slate-700 bg-slate-900/40 p-2">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <Badge tone={m.role === 'user' ? 'accent' : 'neutral'}>{m.role}</Badge>
                <span className="text-slate-500">{formatTs(m.created_at)}</span>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-slate-200">{m.content}</pre>
            </div>
          ))}
        </div>
      </Card>
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
