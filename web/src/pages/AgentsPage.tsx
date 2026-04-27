import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { Badge, Empty, ErrorBanner, PageTitle, Table, Td, Th } from '../components/ui';

interface AgentView {
  id: string;
  name: string;
  default: boolean;
  model: string;
  haikuModel: string;
  skills: string[];
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ agents: AgentView[] }>('/api/agents')
      .then((d) => setAgents(d.agents))
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <PageTitle subtitle="Configured agents. Adding a new one is a config edit + restart — no code change.">
        Agents
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {agents.length === 0 ? (
        <Empty message="No agents configured." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Default</Th>
              <Th>Id</Th>
              <Th>Name</Th>
              <Th>Model</Th>
              <Th>Cheap fallback</Th>
              <Th>Skills</Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="hover:bg-surface-muted/50">
                <Td>{a.default ? <Badge tone="accent">default</Badge> : null}</Td>
                <Td className="font-mono text-xs text-info-ink">{a.id}</Td>
                <Td className="text-sm font-medium text-ink">{a.name}</Td>
                <Td className="text-xs font-mono text-ink-dim">{a.model}</Td>
                <Td className="text-xs font-mono text-ink-faint">{a.haikuModel}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.skills.map((s) => (
                      <Badge key={s} tone={s === '*' ? 'success' : 'info'}>
                        {s}
                      </Badge>
                    ))}
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
