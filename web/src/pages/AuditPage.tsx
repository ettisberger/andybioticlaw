import { useEffect, useState } from 'react';
import { apiGet, formatTs } from '../lib/api';
import { Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface AuditRow {
  id: number;
  at: number;
  kind: string;
  actor: string | null;
  detail: unknown;
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState('');

  useEffect(() => {
    const qs = kindFilter ? `?kind=${encodeURIComponent(kindFilter)}&limit=200` : '?limit=200';
    apiGet<{ entries: AuditRow[] }>(`/api/audit${qs}`)
      .then((d) => setRows(d.entries))
      .catch((e) => setError((e as Error).message));
  }, [kindFilter]);

  return (
    <div>
      <PageTitle subtitle="Security + operational events. Filter by kind (e.g. `unauthorized_access`, `schedule_auto_disabled`).">
        Audit log
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mb-3">
        <input
          type="text"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          placeholder="filter by kind"
          className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500"
        />
      </div>
      {rows.length === 0 ? (
        <Empty message="No matching audit entries." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Kind</Th>
              <Th>Actor</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/40 align-top">
                <Td className="text-xs text-slate-400 whitespace-nowrap">{formatTs(r.at)}</Td>
                <Td className="text-xs font-mono text-sky-300">{r.kind}</Td>
                <Td className="text-xs text-slate-400">{r.actor ?? '—'}</Td>
                <Td className="text-xs text-slate-300">
                  <pre className="max-w-3xl whitespace-pre-wrap break-all">
                    {r.detail ? JSON.stringify(r.detail, null, 2) : ''}
                  </pre>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
