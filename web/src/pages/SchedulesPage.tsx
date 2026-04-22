import { useEffect, useState } from 'react';
import { apiGet, apiPost, formatTs } from '../lib/api';
import { Badge, Button, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface ScheduleRow {
  id: number;
  name: string;
  cron_expr: string;
  kind: string;
  enabled: 0 | 1;
  recurring: 0 | 1;
  budget_tokens_per_day: number | null;
  budget_used_today: number;
  consecutive_fails: number;
  last_run: number | null;
}

/**
 * For one-shot schedules the cron expression is a pinned date (minute, hour,
 * day-of-month, month, any DoW) that encodes a single future instant.
 * Decode it into a human-readable local timestamp; return null if the
 * expression is a classic wildcard recurring pattern.
 */
function oneShotFireAt(cronExpr: string): string | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon] = parts;
  if ([min, hour, dom, mon].some((p) => p === '*' || p.includes('/') || p.includes(','))) {
    return null;
  }
  const now = new Date();
  let year = now.getFullYear();
  // If the month/day already passed this year, assume next year.
  const candidate = new Date(
    year,
    Number(mon) - 1,
    Number(dom),
    Number(hour),
    Number(min),
    0,
  );
  if (candidate.getTime() < now.getTime() - 60_000) {
    candidate.setFullYear(year + 1);
  }
  return candidate.toLocaleString('en-GB', { hour12: false });
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
        <div className="mb-3 rounded border border-info/30 bg-info-bg px-3 py-2 text-sm text-info-ink">
          {msg}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty message="No schedules defined. Use `andybioticlaw schedule add` from the CLI, or ask Emma to remind you at a specific time." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Type</Th>
              <Th>When</Th>
              <Th>State</Th>
              <Th>Budget</Th>
              <Th>Fails</Th>
              <Th>Last run</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const oneShot = s.recurring === 0;
              const fireAt = oneShot ? oneShotFireAt(s.cron_expr) : null;
              return (
                <tr key={s.id} className="hover:bg-surface-muted/50">
                  <Td className="text-xs text-ink-faint">{s.id}</Td>
                  <Td className="font-medium">{s.name}</Td>
                  <Td className="text-xs">{s.kind}</Td>
                  <Td>
                    <Badge tone={oneShot ? 'accent' : 'neutral'}>
                      {oneShot ? 'one-shot' : 'recurring'}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs">
                    {fireAt ? (
                      <span title={s.cron_expr}>{fireAt}</span>
                    ) : (
                      s.cron_expr
                    )}
                  </Td>
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
                  <Td className="text-xs text-ink-dim">{formatTs(s.last_run)}</Td>
                  <Td>
                    <Button variant="ghost" onClick={() => toggle(s.id, !!s.enabled)}>
                      {s.enabled ? 'disable' : 'enable'}
                    </Button>
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
