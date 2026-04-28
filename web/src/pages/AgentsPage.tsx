import { useEffect, useMemo, useState } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { apiGet, apiPatch, ApiError } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBanner,
  PageTitle,
  Table,
  Td,
  Th,
} from '../components/ui';

interface AgentView {
  id: string;
  name: string;
  default: boolean;
  model: string;
  haikuModel: string;
  skills: string[];
  routing: { enabled: boolean; minCharsForOpus: number };
}

interface SkillView {
  name: string;
  description: string;
  enabled: boolean;
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7  (current flagship)' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6  (previous Opus)' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6  (mid-tier)' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5  (cheapest)' },
];

const HAIKU_MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5  (cheapest)' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6  (mid-tier)' },
];

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  function reload(): void {
    apiGet<{ agents: AgentView[] }>('/api/agents')
      .then((d) => setAgents(d.agents))
      .catch((e) => setError((e as Error).message));
  }

  useEffect(() => {
    reload();
    apiGet<{ skills: SkillView[] }>('/api/skills')
      .then((d) => setSkills(d.skills))
      .catch(() => {
        // Skills load failure is non-fatal — operator can still edit
        // model / routing without the skill multi-select being
        // populated; we just hide the picker rows in the editor.
      });
  }, []);

  return (
    <div>
      <PageTitle subtitle="Configured agents — edit per-agent settings here. Adding a new agent or removing one is still a config edit + restart.">
        Agents
      </PageTitle>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {agents.length === 0 ? (
        <Empty message="No agents configured." />
      ) : (
        <div className="space-y-3">
          <Table>
            <thead>
              <tr>
                <Th>Default</Th>
                <Th>Id</Th>
                <Th>Name</Th>
                <Th>Model</Th>
                <Th>Cheap fallback</Th>
                <Th>Router</Th>
                <Th>Skills</Th>
                <Th>{/* edit */}</Th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-surface-muted/50">
                  <Td>{a.default ? <Badge tone="accent">default</Badge> : null}</Td>
                  <Td className="font-mono text-xs text-info-ink">{a.id}</Td>
                  <Td className="text-sm font-medium text-ink">{a.name}</Td>
                  <Td className="font-mono text-xs text-ink-dim">{a.model}</Td>
                  <Td className="font-mono text-xs text-ink-faint">{a.haikuModel}</Td>
                  <Td>
                    {a.routing.enabled ? (
                      <span className="flex items-center gap-2">
                        <Badge tone="success">on</Badge>
                        <span className="text-xs text-ink-faint">
                          ≥{a.routing.minCharsForOpus} chars → Opus
                        </span>
                      </span>
                    ) : (
                      <Badge tone="neutral">off</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {a.skills.map((s) => (
                        <Badge key={s} tone={s === '*' ? 'success' : 'info'}>
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setEditingId((cur) => (cur === a.id ? null : a.id))
                      }
                    >
                      {editingId === a.id ? (
                        <X size={14} strokeWidth={2} />
                      ) : (
                        <Pencil size={14} strokeWidth={2} />
                      )}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {editingId && (
            <AgentEditor
              agent={agents.find((a) => a.id === editingId)!}
              skills={skills}
              onClose={() => setEditingId(null)}
              onSaved={() => {
                setEditingId(null);
                reload();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface AgentEditorProps {
  agent: AgentView;
  skills: SkillView[];
  onClose: () => void;
  onSaved: () => void;
}

function AgentEditor({ agent, skills, onClose, onSaved }: AgentEditorProps) {
  const [model, setModel] = useState(agent.model);
  const [haikuModel, setHaikuModel] = useState(agent.haikuModel);
  const [routingEnabled, setRoutingEnabled] = useState(agent.routing.enabled);
  const [minCharsForOpus, setMinCharsForOpus] = useState(
    agent.routing.minCharsForOpus,
  );
  const initialAllSkills = agent.skills.length === 1 && agent.skills[0] === '*';
  const [allSkills, setAllSkills] = useState(initialAllSkills);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(
    () => new Set(initialAllSkills ? skills.map((s) => s.name) : agent.skills),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restartFields, setRestartFields] = useState<string[]>([]);

  const dirty = useMemo(() => {
    if (model !== agent.model) return true;
    if (haikuModel !== agent.haikuModel) return true;
    if (routingEnabled !== agent.routing.enabled) return true;
    if (minCharsForOpus !== agent.routing.minCharsForOpus) return true;
    // Skills comparison.
    const isAll = allSkills;
    if (isAll !== initialAllSkills) return true;
    if (!isAll) {
      const cur = [...selectedSkills].sort();
      const orig = [...agent.skills].sort();
      if (cur.length !== orig.length) return true;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] !== orig[i]) return true;
      }
    }
    return false;
  }, [
    model,
    haikuModel,
    routingEnabled,
    minCharsForOpus,
    allSkills,
    selectedSkills,
    agent,
    initialAllSkills,
  ]);

  function toggleSkill(name: string): void {
    setAllSkills(false);
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setRestartFields([]);
    const patch: Record<string, unknown> = {};
    if (model !== agent.model) patch.model = model;
    if (haikuModel !== agent.haikuModel) patch.haikuModel = haikuModel;
    const routingPatch: Record<string, unknown> = {};
    if (routingEnabled !== agent.routing.enabled) {
      routingPatch.enabled = routingEnabled;
    }
    if (minCharsForOpus !== agent.routing.minCharsForOpus) {
      routingPatch.minCharsForOpus = minCharsForOpus;
    }
    if (Object.keys(routingPatch).length > 0) patch.routing = routingPatch;

    const isAllNow = allSkills;
    if (isAllNow && !initialAllSkills) {
      patch.skills = '*';
    } else if (!isAllNow) {
      const explicit = [...selectedSkills].sort();
      const orig = [...agent.skills].sort();
      const changed =
        explicit.length !== orig.length ||
        explicit.some((s, i) => s !== orig[i]);
      if (changed || initialAllSkills) {
        patch.skills = explicit;
      }
    }

    try {
      const res = await apiPatch<{
        agent: AgentView;
        restartRequired: string[];
      }>(`/api/agents/${encodeURIComponent(agent.id)}`, patch);
      if (res.restartRequired.length > 0) {
        // Surface but don't block — the operator may want to make more
        // edits and restart once at the end. We close the editor so
        // they can see the updated row, but show the warning briefly.
        setRestartFields(res.restartRequired);
        // Auto-close after a short pause so the warning doesn't get
        // missed but the editor doesn't pin them either.
        setTimeout(onSaved, 1500);
      } else {
        onSaved();
      }
    } catch (e) {
      const msg =
        e instanceof ApiError && typeof e.body === 'object' && e.body && 'error' in e.body
          ? String((e.body as { error: unknown }).error)
          : (e as Error).message;
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          Edit{' '}
          <span className="font-mono text-info-ink">{agent.id}</span>
          <span className="ml-2 font-normal text-ink-faint">({agent.name})</span>
        </h3>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Model" hint="restart required after change">
          <select
            className={selectClass}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cheap fallback model" hint="live; used by router">
          <select
            className={selectClass}
            value={haikuModel}
            onChange={(e) => setHaikuModel(e.target.value)}
          >
            {HAIKU_MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Route simple DMs to Haiku"
          hint="live · cost saver, sends short DMs to the cheap model"
        >
          <label className="inline-flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={routingEnabled}
              onChange={(e) => setRoutingEnabled(e.target.checked)}
            />
            <span>{routingEnabled ? 'Routing on' : 'Routing off'}</span>
          </label>
        </Field>
        <Field
          label="Length cutoff → Opus (chars)"
          hint="live · DMs at or above this length go to the main model"
        >
          <input
            type="number"
            min={0}
            max={10000}
            disabled={!routingEnabled}
            className={`${inputClass} disabled:opacity-40`}
            value={minCharsForOpus}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0) setMinCharsForOpus(n);
            }}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Skills"
          hint='restart required · all checked = ["*"] shorthand'
        >
          <label className="mb-2 inline-flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={allSkills}
              onChange={(e) => {
                setAllSkills(e.target.checked);
                if (e.target.checked) {
                  setSelectedSkills(new Set(skills.map((s) => s.name)));
                }
              }}
            />
            <span>All skills (wildcard)</span>
          </label>
          {!allSkills && (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {skills.length === 0 ? (
                <span className="text-xs text-ink-faint">
                  No skills loaded by the running service.
                </span>
              ) : (
                skills.map((s) => (
                  <label
                    key={s.name}
                    className="inline-flex items-start gap-2 text-sm text-ink"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedSkills.has(s.name)}
                      onChange={() => toggleSkill(s.name)}
                    />
                    <span>
                      <span className="font-mono">{s.name}</span>
                      {s.description && (
                        <span className="ml-2 text-xs text-ink-faint">
                          {s.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))
              )}
            </div>
          )}
        </Field>
      </div>

      {restartFields.length > 0 && (
        <div className="mt-4 rounded-md bg-warn-bg/60 p-3 text-xs text-warn-ink">
          Saved. These fields require{' '}
          <code className="font-mono">sudo systemctl restart andybioticlaw</code>{' '}
          to take effect: {restartFields.join(', ')}
        </div>
      )}
      {saveError && (
        <div className="mt-4 rounded-md bg-error-bg/60 p-3 text-xs text-error-ink">
          {saveError}
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={!dirty || saving}
        >
          <Save size={14} strokeWidth={2} />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

const inputClass =
  'w-full rounded-md border border-line/60 bg-surface/50 px-2 py-1 text-sm text-ink focus:border-accent-ink focus:outline-none';
const selectClass = inputClass;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-dim">
        {label}
      </div>
      {children}
      {hint && (
        <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>
      )}
    </div>
  );
}
