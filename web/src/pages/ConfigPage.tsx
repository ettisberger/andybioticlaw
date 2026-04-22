import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { ErrorBanner, PageTitle } from '../components/ui';

export function ConfigPage() {
  const [cfg, setCfg] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ config: unknown }>('/api/config')
      .then((d) => setCfg(d.config))
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;

  return (
    <div>
      <PageTitle subtitle="Read-only. Secrets are redacted. Edit config/config.yaml + SIGHUP (or restart) to apply.">
        Config
      </PageTitle>
      {cfg === null ? (
        <div className="text-slate-400">loading…</div>
      ) : (
        <pre className="overflow-auto rounded border border-slate-700 bg-slate-950 p-4 font-mono text-xs text-slate-200">
          {JSON.stringify(cfg, null, 2)}
        </pre>
      )}
    </div>
  );
}
