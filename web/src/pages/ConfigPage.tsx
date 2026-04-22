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
        <div className="text-ink-dim">loading…</div>
      ) : (
        <pre className="overflow-auto rounded-xl border border-line bg-surface-muted p-5 font-mono text-xs leading-relaxed text-ink">
          {JSON.stringify(cfg, null, 2)}
        </pre>
      )}
    </div>
  );
}
