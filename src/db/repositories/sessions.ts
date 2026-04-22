import type { Database } from 'better-sqlite3';

export type SessionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'crashed'
  | 'orphaned';

export type SessionSource = 'dm' | 'group' | 'schedule' | 'api';

export interface SessionRecord {
  id: string;
  source: SessionSource;
  source_ref: string | null;
  status: SessionStatus;
  input_preview: string | null;
  started_at: number;
  ended_at: number | null;
  tokens_input: number;
  tokens_output: number;
  error: string | null;
  workspace_path: string | null;
  model: string | null;
}

export interface CreateSessionInput {
  id: string;
  source: SessionSource;
  source_ref: string;
  status: SessionStatus;
  input_preview: string;
  model: string;
  workspace_path?: string;
}

export interface UpdateSessionInput {
  status?: SessionStatus;
  tokens_input?: number;
  tokens_output?: number;
  error?: string | null;
  ended_at?: number;
}

export interface SessionsRepo {
  create(input: CreateSessionInput): void;
  update(id: string, patch: UpdateSessionInput): void;
  get(id: string): SessionRecord | null;
  markRunningAsOrphaned(): { count: number; chatIds: string[] };
  list(opts?: { status?: SessionStatus; limit?: number }): SessionRecord[];
  tokensUsedBetween(fromMs: number, toMs: number): number;
}

export function createSessionsRepo(db: Database): SessionsRepo {
  const insert = db.prepare(
    `INSERT INTO sessions (id, source, source_ref, status, input_preview, started_at, model, workspace_path, tokens_input, tokens_output)
     VALUES (@id, @source, @source_ref, @status, @input_preview, @started_at, @model, @workspace_path, 0, 0)`,
  );

  const selectOne = db.prepare<{ id: string }, SessionRecord>(
    `SELECT * FROM sessions WHERE id = @id`,
  );

  const selectByStatus = db.prepare<{ status: SessionStatus; limit: number }, SessionRecord>(
    `SELECT * FROM sessions WHERE status = @status ORDER BY started_at DESC LIMIT @limit`,
  );

  const selectRecent = db.prepare<{ limit: number }, SessionRecord>(
    `SELECT * FROM sessions ORDER BY started_at DESC LIMIT @limit`,
  );

  const orphanSelect = db.prepare<[], { id: string; source_ref: string | null }>(
    `SELECT id, source_ref FROM sessions WHERE status IN ('running','queued')`,
  );

  const orphanUpdate = db.prepare<{ now: number }>(
    `UPDATE sessions SET status = 'orphaned', ended_at = @now, error = 'service restarted mid-session' WHERE status IN ('running','queued')`,
  );

  const tokensSum = db.prepare<
    { from: number; to: number },
    { total: number | null }
  >(
    `SELECT COALESCE(SUM(tokens_input + tokens_output), 0) AS total FROM sessions WHERE started_at >= @from AND started_at < @to`,
  );

  return {
    create(input) {
      insert.run({
        id: input.id,
        source: input.source,
        source_ref: input.source_ref,
        status: input.status,
        input_preview: input.input_preview.slice(0, 500),
        started_at: Date.now(),
        model: input.model,
        workspace_path: input.workspace_path ?? null,
      });
    },
    update(id, patch) {
      const keys = Object.keys(patch) as (keyof UpdateSessionInput)[];
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = @${k}`).join(', ');
      const stmt = db.prepare(`UPDATE sessions SET ${sets} WHERE id = @id`);
      stmt.run({ id, ...patch });
    },
    get(id) {
      return selectOne.get({ id }) ?? null;
    },
    list({ status, limit = 20 } = {}) {
      return status
        ? selectByStatus.all({ status, limit })
        : selectRecent.all({ limit });
    },
    markRunningAsOrphaned() {
      const rows = orphanSelect.all();
      orphanUpdate.run({ now: Date.now() });
      const chatIds = Array.from(
        new Set(
          rows
            .map((r) => r.source_ref)
            .filter((v): v is string => typeof v === 'string'),
        ),
      );
      return { count: rows.length, chatIds };
    },
    tokensUsedBetween(fromMs, toMs) {
      const row = tokensSum.get({ from: fromMs, to: toMs });
      return row?.total ?? 0;
    },
  };
}
