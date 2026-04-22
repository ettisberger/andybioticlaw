import type { Database } from 'better-sqlite3';

export interface AuditRecord {
  id: number;
  at: number;
  kind: string;
  actor: string | null;
  detail: unknown;
}

export interface RecordAuditInput {
  kind: string;
  actor?: string;
  detail?: unknown;
}

export interface AuditRepo {
  record(input: RecordAuditInput): number;
  list(opts?: { limit?: number; kind?: string }): AuditRecord[];
  show(id: number): AuditRecord | null;
}

export function createAuditRepo(db: Database): AuditRepo {
  const insert = db.prepare(
    'INSERT INTO audit (at, kind, actor, detail) VALUES (@at, @kind, @actor, @detail)',
  );
  const selectRecent = db.prepare<
    { limit: number },
    { id: number; at: number; kind: string; actor: string | null; detail: string | null }
  >('SELECT id, at, kind, actor, detail FROM audit ORDER BY at DESC LIMIT @limit');
  const selectByKind = db.prepare<
    { kind: string; limit: number },
    { id: number; at: number; kind: string; actor: string | null; detail: string | null }
  >(
    'SELECT id, at, kind, actor, detail FROM audit WHERE kind = @kind ORDER BY at DESC LIMIT @limit',
  );
  const selectOne = db.prepare<
    { id: number },
    { id: number; at: number; kind: string; actor: string | null; detail: string | null }
  >('SELECT id, at, kind, actor, detail FROM audit WHERE id = @id');

  function parseDetail(raw: string | null): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return {
    record({ kind, actor, detail }) {
      const result = insert.run({
        at: Date.now(),
        kind,
        actor: actor ?? null,
        detail: detail === undefined ? null : JSON.stringify(detail),
      });
      return Number(result.lastInsertRowid);
    },
    list({ limit = 50, kind } = {}) {
      const rows = kind
        ? selectByKind.all({ kind, limit })
        : selectRecent.all({ limit });
      return rows.map((r) => ({ ...r, detail: parseDetail(r.detail) }));
    },
    show(id) {
      const row = selectOne.get({ id });
      if (!row) return null;
      return { ...row, detail: parseDetail(row.detail) };
    },
  };
}
