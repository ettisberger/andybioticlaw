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
  if (level === undefined) return 'text-ink';
  if (level >= 50) return 'text-error-ink';
  if (level >= 40) return 'text-warn-ink';
  if (level >= 30) return 'text-ink';
  return 'text-ink-faint';
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
        className="flex-1 overflow-auto rounded-xl border border-line bg-surface-muted p-4 font-mono text-xs leading-5"
      >
        {lines.length === 0 && (
          <div className="text-ink-faint">waiting for log lines…</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap ${levelColor(l.level)}`}>
            <span className="text-ink-faint">
              {l.time?.slice(11, 19) ?? ''}
            </span>{' '}
            <span className="font-medium">{levelLabel(l.level).padEnd(5)}</span>{' '}
            <span>{l.msg ?? l.raw}</span>
            {l.extras && (
              <span className="text-ink-faint">
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
