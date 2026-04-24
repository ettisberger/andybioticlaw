import { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, formatTs, truncate } from '../lib/api';
import { Button, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface MemoryRow {
  id: number;
  scope: string;
  key: string | null;
  value: string;
  source: string;
  ttl_at: number | null;
  updated_at: number;
  created_at: number;
  last_used_at: number | null;
  pinned: number;
}

type SortMode = 'updated' | 'last_used' | 'created';

const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function MemoryPage() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<string>('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>('updated');

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

  async function togglePin(row: MemoryRow) {
    try {
      const next = row.pinned === 0;
      await apiPost(`/api/memory/${row.id}/pin`, { pinned: next });
      setMsg(next ? `pinned #${row.id}` : `unpinned #${row.id}`);
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
    const now = Date.now();
    const staleBefore = now - STALE_THRESHOLD_MS;
    const out = rows.filter((r) => {
      if (scope && r.scope !== scope) return false;
      if (staleOnly) {
        if (r.pinned === 1) return false;
        // "never read" counts as stale; otherwise compare threshold.
        if (r.last_used_at !== null && r.last_used_at >= staleBefore) return false;
      }
      if (!q) return true;
      const hay = `${r.key ?? ''}\n${r.value}\n${r.source}`.toLowerCase();
      return hay.includes(q);
    });
    // Sort is applied after filtering. Treat null last_used_at as 0 so
    // "never read" entries sink to the bottom when sorting by last_used.
    const keyFor = (r: MemoryRow) => {
      if (sort === 'created') return r.created_at;
      if (sort === 'last_used') return r.last_used_at ?? 0;
      return r.updated_at;
    };
    return out.slice().sort((a, b) => keyFor(b) - keyFor(a));
  }, [rows, search, scope, staleOnly, sort]);

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
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm"
          title="Sort by"
        >
          <option value="updated">Sort: Updated</option>
          <option value="last_used">Sort: Last used</option>
          <option value="created">Sort: Created</option>
        </select>
        <label className="flex items-center gap-1.5 rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm">
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />
          Stale only (90d+, unpinned)
        </label>
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
              <Th>Last used</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-surface-muted/50">
                <Td className="text-xs text-ink-faint">
                  {r.pinned === 1 ? <span title="pinned">📌</span> : null} {r.id}
                </Td>
                <Td className="font-mono text-xs text-info-ink">{r.scope}</Td>
                <Td className="text-xs text-ink-dim">{r.key ?? '—'}</Td>
                <Td className="text-sm">{truncate(r.value, 150)}</Td>
                <Td className="text-xs text-ink-dim">{r.source}</Td>
                <Td className="text-xs text-ink-dim">{formatTs(r.ttl_at)}</Td>
                <Td className="text-xs text-ink-dim">{formatTs(r.updated_at)}</Td>
                <Td className="text-xs text-ink-dim">{formatTs(r.last_used_at)}</Td>
                <Td>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      onClick={() => togglePin(r)}
                      title={r.pinned === 1 ? 'unpin' : 'pin — protect from Stale filter'}
                    >
                      {r.pinned === 1 ? 'unpin' : 'pin'}
                    </Button>
                    <Button variant="ghost" onClick={() => remove(r)}>
                      delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
