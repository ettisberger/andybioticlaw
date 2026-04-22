import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { Badge, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface SkillRow {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  scope: string[];
  requiredSecrets: string[];
  mcpServerCount: number;
}

export function SkillsPage() {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ skills: SkillRow[] }>('/api/skills')
      .then((d) => setRows(d.skills))
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;

  return (
    <div>
      <PageTitle subtitle="Skill infrastructure. v1 ships no user skills — see skills/_template/ for scaffolding.">
        Skills
      </PageTitle>
      {rows.length === 0 ? (
        <Empty message="No skills loaded. Drop a manifest.yaml + SKILL.md into skills/<name>/ and restart." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>State</Th>
              <Th>Name</Th>
              <Th>Version</Th>
              <Th>Scope</Th>
              <Th>Description</Th>
              <Th>Required secrets</Th>
              <Th>MCP servers</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.name} className="hover:bg-slate-800/40">
                <Td>
                  <Badge tone={s.enabled ? 'success' : 'neutral'}>
                    {s.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </Td>
                <Td className="font-medium">{s.name}</Td>
                <Td className="text-xs">{s.version}</Td>
                <Td className="text-xs">{s.scope.join(', ')}</Td>
                <Td className="text-sm">{s.description}</Td>
                <Td className="text-xs font-mono">
                  {s.requiredSecrets.length === 0 ? '—' : s.requiredSecrets.join(', ')}
                </Td>
                <Td className="text-xs">{s.mcpServerCount}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
