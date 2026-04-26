import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Pin, PinOff, Archive, ArchiveRestore, Trash2, Plus, X, Edit3, Save } from 'lucide-react';
import { apiDelete, apiGet, apiPost, ApiError } from '../lib/api';
import {
  Badge,
  Button,
  Empty,
  ErrorBanner,
  PageTitle,
  Table,
  Td,
  Th,
} from '../components/ui';

interface NoteListItem {
  id: number;
  title: string | null;
  snippet: string;
  tags: string[];
  source: string;
  pinned: boolean;
  archived: boolean;
  updated_at: number;
}

interface NoteDetail extends NoteListItem {
  body: string;
  created_at: number;
}

type Tab = 'active' | 'archived';

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function deriveTitle(note: NoteListItem | NoteDetail, snippetSource?: string): string {
  if (note.title && note.title.trim() !== '') return note.title;
  const body = snippetSource ?? ('body' in note ? note.body : note.snippet);
  const firstLine = body.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine || '(untitled)';
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const csrfMatch = /(?:^|;\s*)_abl_csrf=([0-9a-f]{64})/i.exec(
    typeof document !== 'undefined' ? document.cookie : '',
  );
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfMatch) headers['X-CSRF-Token'] = csrfMatch[1]!;
  const r = await fetch(path, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new ApiError(r.status, j, `PATCH ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

export function NotesPage() {
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const debouncedSearch = useDebounced(search, 200);

  const [rows, setRows] = useState<NoteListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const params = new URLSearchParams();
      params.set('limit', '500');
      params.set('includeArchived', tab === 'archived' ? 'true' : 'false');
      if (debouncedSearch.trim()) params.set('query', debouncedSearch.trim());
      if (tagFilter) params.set('tag', tagFilter);
      const data = await apiGet<{
        notes: NoteListItem[];
        count: number;
        total: number;
      }>(`/api/notes?${params.toString()}`);
      // Server returns active OR archived+active when includeArchived; in
      // archived-tab mode we want to filter to archived only.
      const filtered =
        tab === 'archived' ? data.notes.filter((n) => n.archived) : data.notes;
      setRows(filtered);
      setTotal(data.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [tab, debouncedSearch, tagFilter]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const t of r.tags) s.add(t);
    return Array.from(s).sort();
  }, [rows]);

  return (
    <div>
      <PageTitle subtitle="Markdown notes Emma can save and recall via the notes skill, or you can write directly here.">
        Notes
      </PageTitle>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {msg && (
        <div className="mb-3 rounded border border-info/30 bg-info-bg px-3 py-2 text-sm text-info-ink">
          {msg}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line bg-surface/60 p-0.5 backdrop-blur-sm">
          <button
            onClick={() => setTab('active')}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              tab === 'active'
                ? 'bg-accent-bg text-accent-ink'
                : 'text-ink-dim hover:text-ink'
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setTab('archived')}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
              tab === 'archived'
                ? 'bg-accent-bg text-accent-ink'
                : 'text-ink-dim hover:text-ink'
            }`}
          >
            Archived
          </button>
        </div>

        <input
          type="text"
          placeholder="Search title, body, tags…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[14rem] rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />

        {tagFilter && (
          <Button variant="ghost" onClick={() => setTagFilter('')}>
            tag: {tagFilter} ✕
          </Button>
        )}

        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={14} className="mr-1" /> New note
        </Button>

        <div className="text-xs text-ink-faint">
          {rows.length} of {total}
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {allTags.map((t) => (
            <button
              key={t}
              onClick={() => setTagFilter(t === tagFilter ? '' : t)}
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                t === tagFilter
                  ? 'bg-accent text-white'
                  : 'bg-surface-muted text-ink-dim hover:bg-accent-bg hover:text-accent-ink'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          message={
            total === 0
              ? tab === 'archived'
                ? 'No archived notes.'
                : 'No notes yet. Click "+ New note" or ask Emma to save one.'
              : 'No notes match this filter.'
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Title</Th>
              <Th>Tags</Th>
              <Th>Source</Th>
              <Th>Updated</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setOpenDetail(r.id)}
                className="cursor-pointer hover:bg-surface-muted/50"
              >
                <Td className="text-xs text-ink-faint">
                  {r.pinned && <Pin size={12} className="mr-1 inline text-accent" />}
                  {r.id}
                </Td>
                <Td className="text-sm font-medium text-ink">{deriveTitle(r)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <Badge key={t} tone="info">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="text-xs text-ink-dim">{r.source}</Td>
                <Td className="text-xs text-ink-dim">{relTime(r.updated_at)}</Td>
                <Td />
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {openDetail !== null && (
        <NoteDrawer
          id={openDetail}
          onClose={() => setOpenDetail(null)}
          onChanged={(m) => {
            setMsg(m);
            void load();
          }}
        />
      )}

      {creating && (
        <CreateNoteModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setMsg(`created note #${id}`);
            void load();
            setOpenDetail(id);
          }}
        />
      )}
    </div>
  );
}

// ---- Create modal -------------------------------------------------------

function CreateNoteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!body.trim()) {
      setErr('body is required');
      return;
    }
    setSubmitting(true);
    try {
      const tags = tagsInput
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const created = await apiPost<{ id: number }>('/api/notes', {
        body,
        title: title.trim() || null,
        tags,
      });
      onCreated(created.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="glass glass-highlight w-full max-w-2xl rounded-2xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">New note</h2>
          <Button variant="ghost" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
        {err && <ErrorBanner>{err}</ErrorBanner>}
        <input
          type="text"
          placeholder="Title (optional — derived from first line if blank)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-2 w-full rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />
        <textarea
          placeholder="Markdown body…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          className="mb-2 w-full rounded-lg border border-line bg-surface/60 px-3 py-2 text-sm text-ink backdrop-blur-sm placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />
        <input
          type="text"
          placeholder="Tags (comma- or space-separated)"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          className="mb-3 w-full rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Saving…' : 'Save note'}
          </Button>
        </div>
      </div>
    </Backdrop>
  );
}

// ---- Detail drawer ------------------------------------------------------

function NoteDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: (msg: string) => void;
}) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const n = await apiGet<NoteDetail>(`/api/notes/${id}`);
      setNote(n);
      setDraftBody(n.body);
      setDraftTitle(n.title ?? '');
      setDraftTags(n.tags.join(', '));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  async function save() {
    try {
      const tags = draftTags
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await apiPatch<NoteDetail>(`/api/notes/${id}`, {
        body: draftBody,
        title: draftTitle.trim() || null,
        tags,
      });
      setEditing(false);
      await load();
      onChanged(`saved #${id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function togglePin() {
    if (!note) return;
    try {
      await apiPost(`/api/notes/${id}/pin`, { pinned: !note.pinned });
      await load();
      onChanged(note.pinned ? `unpinned #${id}` : `pinned #${id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function toggleArchive() {
    if (!note) return;
    try {
      const path = note.archived
        ? `/api/notes/${id}/unarchive`
        : `/api/notes/${id}/archive`;
      await apiPost(path);
      await load();
      onChanged(note.archived ? `unarchived #${id}` : `archived #${id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function hardDelete() {
    if (!window.confirm(`Permanently delete note #${id}? This cannot be undone.`)) return;
    try {
      await apiDelete(`/api/notes/${id}`);
      onChanged(`deleted #${id}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="glass glass-highlight ml-auto h-full w-full max-w-2xl overflow-auto rounded-l-2xl p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-xs text-ink-faint">note #{id}</div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" onClick={() => void togglePin()} title="Pin / unpin">
              {note?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </Button>
            <Button variant="ghost" onClick={() => void toggleArchive()} title="Archive / unarchive">
              {note?.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </Button>
            <Button variant="ghost" onClick={() => void hardDelete()} title="Hard delete">
              <Trash2 size={14} />
            </Button>
            <Button variant="ghost" onClick={onClose}>
              <X size={16} />
            </Button>
          </div>
        </div>

        {err && <ErrorBanner>{err}</ErrorBanner>}

        {!note ? (
          <div className="text-ink-dim">loading…</div>
        ) : editing ? (
          <>
            <input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title"
              className="mb-2 w-full rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm focus:border-accent/50 focus:outline-none"
            />
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              rows={20}
              className="mb-2 w-full rounded-lg border border-line bg-surface/60 px-3 py-2 font-mono text-sm text-ink backdrop-blur-sm focus:border-accent/50 focus:outline-none"
            />
            <input
              type="text"
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              placeholder="Tags (comma- or space-separated)"
              className="mb-3 w-full rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-sm text-ink backdrop-blur-sm focus:border-accent/50 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void save()}>
                <Save size={14} className="mr-1" /> Save
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-xl font-semibold text-ink">{deriveTitle(note)}</h1>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              <span>updated {relTime(note.updated_at)}</span>
              <span>·</span>
              <span>via {note.source}</span>
              {note.archived && <Badge tone="warn">archived</Badge>}
              {note.pinned && <Badge tone="accent">pinned</Badge>}
            </div>
            {note.tags.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1">
                {note.tags.map((t) => (
                  <Badge key={t} tone="info">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
            <div className="prose-notes mb-4">
              <ReactMarkdown>{note.body}</ReactMarkdown>
            </div>
            <Button variant="primary" onClick={() => setEditing(true)}>
              <Edit3 size={14} className="mr-1" /> Edit
            </Button>
          </>
        )}
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 backdrop-blur-sm"
    >
      <div onClick={(e) => e.stopPropagation()} className="contents">
        {children}
      </div>
    </div>
  );
}
