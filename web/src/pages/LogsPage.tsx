import { useEffect, useRef, useState } from 'react';
import { PageTitle } from '../components/ui';

const MAX_LINES = 500;

interface ParsedLine {
  raw: string;
  level?: number;
  time?: string;
  msg?: string;
  extras?: Record<string, unknown>;
}

function parseLine(raw: string): ParsedLine {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const { level, time, msg, pid: _pid, hostname: _hostname, svc: _svc, ...rest } = obj;
    return {
      raw,
      level: typeof level === 'number' ? level : undefined,
      time: typeof time === 'string' ? time : undefined,
      msg: typeof msg === 'string' ? msg : undefined,
      extras: Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined,
    };
  } catch {
    return { raw };
  }
}

function levelColor(level?: number): string {
  if (level === undefined) return 'text-slate-300';
  if (level >= 50) return 'text-rose-300';
  if (level >= 40) return 'text-amber-300';
  if (level >= 30) return 'text-slate-200';
  return 'text-slate-500';
}

function levelLabel(level?: number): string {
  if (level === undefined) return '';
  if (level >= 60) return 'FATAL';
  if (level >= 50) return 'ERROR';
  if (level >= 40) return 'WARN';
  if (level >= 30) return 'INFO';
  if (level >= 20) return 'DEBUG';
  return 'TRACE';
}

export function LogsPage() {
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/logs/stream`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      const parsed = parseLine(data);
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(-MAX_LINES + 1) : prev.slice();
        next.push(parsed);
        return next;
      });
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  return (
    <div className="flex h-full flex-col">
      <PageTitle
        subtitle={`${connected ? '● live' : '○ disconnected'} · showing up to last ${MAX_LINES} lines · scroll up to pause auto-follow`}
      >
        Logs
      </PageTitle>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-5"
      >
        {lines.length === 0 && (
          <div className="text-slate-500">waiting for log lines…</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap ${levelColor(l.level)}`}>
            <span className="text-slate-600">
              {l.time?.slice(11, 19) ?? ''}
            </span>{' '}
            <span className="font-medium">{levelLabel(l.level).padEnd(5)}</span>{' '}
            <span>{l.msg ?? l.raw}</span>
            {l.extras && (
              <span className="text-slate-500">
                {'  '}
                {Object.entries(l.extras)
                  .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                  .join(' ')}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
