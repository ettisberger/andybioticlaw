import { useEffect, useState } from 'react';
import { apiGet, apiPost, formatTs } from '../lib/api';
import { Badge, Button, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface ScheduleRow {
  id: number;
  name: string;
  cron_expr: string;
  kind: string;
  enabled: 0 | 1;
  budget_tokens_per_day: number | null;
  budget_used_today: number;
  consecutive_fails: number;
  last_run: number | null;
}

export function SchedulesPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiGet<{ schedules: ScheduleRow[] }>('/api/schedules');
      setRows(data.schedules);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle(id: number, enabled: boolean) {
    try {
      await apiPost(`/api/schedules/${id}/${enabled ? 'disable' : 'enable'}`);
      setMsg(`${enabled ? 'disabled' : 'enabled'} #${id}`);
      await load();
    } catch (e) {
      setMsg(`failed: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <PageTitle subtitle="Enable/disable here; creating new schedules lives in the CLI for now.">
        Schedules
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {msg && (
        <div className="mb-3 rounded border border-sky-800 bg-sky-900/40 px-3 py-2 text-sm text-sky-200">
          {msg}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty message="No schedules defined. Use `andybioticlaw schedule add` from the CLI." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Cron</Th>
              <Th>State</Th>
              <Th>Budget</Th>
              <Th>Fails</Th>
              <Th>Last run</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-slate-800/40">
                <Td className="text-xs text-slate-500">{s.id}</Td>
                <Td className="font-medium">{s.name}</Td>
                <Td className="text-xs">{s.kind}</Td>
                <Td className="font-mono text-xs">{s.cron_expr}</Td>
                <Td>
                  <Badge tone={s.enabled ? 'success' : 'neutral'}>
                    {s.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </Td>
                <Td className="text-xs">
                  {s.budget_tokens_per_day
                    ? `${s.budget_used_today}/${s.budget_tokens_per_day}`
                    : '—'}
                </Td>
                <Td className="text-xs">
                  {s.consecutive_fails > 0 ? (
                    <Badge tone="error">{s.consecutive_fails}</Badge>
                  ) : (
                    '0'
                  )}
                </Td>
                <Td className="text-xs text-slate-400">{formatTs(s.last_run)}</Td>
                <Td>
                  <Button variant="ghost" onClick={() => toggle(s.id, !!s.enabled)}>
                    {s.enabled ? 'disable' : 'enable'}
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
