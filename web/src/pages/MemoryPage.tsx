import { useEffect, useMemo, useState } from 'react';
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
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<string>('');

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

  async function remove(row: MemoryRow) {
    const label = row.key ?? truncate(row.value, 60);
    if (!window.confirm(`Permanently delete memory entry #${row.id}?\n\n${row.scope}: ${label}`)) {
      return;
    }
    try {
      await apiDelete(`/api/memory/${row.id}`);
      setMsg(`removed #${row.id}`);
      await load();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  }

  // Distinct scopes present in loaded rows — populated live so filter
  // options always match what's actually stored.
  const scopes = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.scope);
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (scope && r.scope !== scope) return false;
      if (!q) return true;
      const hay = `${r.key ?? ''}\n${r.value}\n${r.source}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, scope]);

  return (
    <div>
      <PageTitle subtitle="All stored memory entries, scoped. Add new ones via Telegram (ask Emma) or the CLI.">
        Memory
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {msg && (
        <div className="mb-3 rounded border border-info/30 bg-info-bg px-3 py-2 text-sm text-info-ink">
          {msg}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search key, value, or source…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[12rem] rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm"
        >
          <option value="">All scopes</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="text-xs text-ink-faint">
          {filtered.length} of {rows.length}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty
          message={
            rows.length === 0
              ? 'No memory entries yet.'
              : 'No entries match this filter.'
          }
        />
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
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-surface-muted/50">
                <Td className="text-xs text-ink-faint">{r.id}</Td>
                <Td className="font-mono text-xs text-info-ink">{r.scope}</Td>
                <Td className="text-xs text-ink-dim">{r.key ?? '—'}</Td>
                <Td className="text-sm">{truncate(r.value, 150)}</Td>
                <Td className="text-xs text-ink-dim">{r.source}</Td>
                <Td className="text-xs text-ink-dim">{formatTs(r.ttl_at)}</Td>
                <Td className="text-xs text-ink-dim">{formatTs(r.updated_at)}</Td>
                <Td>
                  <Button variant="ghost" onClick={() => remove(r)}>
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
