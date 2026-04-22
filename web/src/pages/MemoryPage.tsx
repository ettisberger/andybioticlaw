import { useEffect, useState } from 'react';
import { apiDelete, apiGet, formatTs, truncate } from '../lib/api';
import { Button, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface MemoryRow {
  id: number;
  scope: string;
  key: string | null;
  value: string;
  source: string;
  ttl_at: number | null;
  updated_at: number;
}

export function MemoryPage() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiGet<{ entries: MemoryRow[] }>('/api/memory?limit=500');
      setRows(data.entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id: number) {
    try {
      await apiDelete(`/api/memory/${id}`);
      setMsg(`removed #${id}`);
      await load();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <PageTitle subtitle="All stored memory entries, scoped. Add new ones via Telegram (ask Emma) or the CLI.">
        Memory
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {msg && (
        <div className="mb-3 rounded border border-sky-800 bg-sky-900/40 px-3 py-2 text-sm text-sky-200">
          {msg}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty message="No memory entries yet." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Scope</Th>
              <Th>Key</Th>
              <Th>Value</Th>
              <Th>Source</Th>
              <Th>TTL</Th>
              <Th>Updated</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/40">
                <Td className="text-xs text-slate-500">{r.id}</Td>
                <Td className="font-mono text-xs text-sky-300">{r.scope}</Td>
                <Td className="text-xs text-slate-400">{r.key ?? '—'}</Td>
                <Td className="text-sm">{truncate(r.value, 150)}</Td>
                <Td className="text-xs text-slate-400">{r.source}</Td>
                <Td className="text-xs text-slate-400">{formatTs(r.ttl_at)}</Td>
                <Td className="text-xs text-slate-400">{formatTs(r.updated_at)}</Td>
                <Td>
                  <Button variant="ghost" onClick={() => remove(r.id)}>
                    delete
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
