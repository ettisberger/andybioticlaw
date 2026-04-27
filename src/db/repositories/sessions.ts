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

/** Allowlist of columns accepted by `SessionsRepo.update()`. Interpolated
 *  directly into SQL — must be kept in sync with `UpdateSessionInput`. */
const ALLOWED_SESSION_UPDATE_KEYS: readonly (keyof UpdateSessionInput)[] = [
  'status',
  'tokens_input',
  'tokens_output',
  'error',
  'ended_at',
];

export interface DailyRawRow {
  /** Epoch ms, session start. Use this to bucket by the operator's tz in JS. */
  started_at: number;
  /** `tokens_input + tokens_output` as one scalar (frontend rarely needs the split). */
  tokens: number;
  /** Nullable per migration 0001; `null` → "unknown" bucket. */
  model: string | null;
}

export interface PerModelTotals {
  /** `null` when the session record has no model recorded. */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  sessions: number;
}

export interface SessionsRepo {
  create(input: CreateSessionInput): void;
  update(id: string, patch: UpdateSessionInput): void;
  get(id: string): SessionRecord | null;
  markRunningAsOrphaned(): { count: number; chatIds: string[] };
  /**
   * Hard-delete a session by id. `messages` cascade automatically (FK).
   * Also cleans non-FK orphans in `memory_proposals` and
   * `pending_email_sends` whose session_id columns point at this row.
   * Returns `{ session, messages, proposals, emailSends }` row counts so
   * callers can audit / show a confirmation.
   */
  remove(id: string): {
    session: number;
    messages: number;
    proposals: number;
    emailSends: number;
  };
  list(opts?: { status?: SessionStatus; limit?: number }): SessionRecord[];
  tokensUsedBetween(fromMs: number, toMs: number): number;
  /** Sum of `tokens_input + tokens_output` for sessions started since `fromMs`. */
  tokensUsedSince(fromMs: number): number;
  /**
   * Per-session raw rows in a window — used by the dashboard stats endpoint
   * for JS-side timezone bucketing. 30 days × ~200 sessions/day = tiny
   * payload; no need for pre-aggregation here.
   */
  dailyRaw(fromMs: number, toMs: number): DailyRawRow[];
  /** Per-model token totals + session counts for sessions started since `fromMs`. */
  perModelTotals(fromMs: number): PerModelTotals[];
  /** Aggregate totals (input, output, session count) in a window. */
  totalsBetween(
    fromMs: number,
    toMs: number,
  ): { tokensIn: number; tokensOut: number; sessions: number };
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

  const dailyRawStmt = db.prepare<
    { from: number; to: number },
    { started_at: number; tokens: number; model: string | null }
  >(
    `SELECT started_at, (tokens_input + tokens_output) AS tokens, model
     FROM sessions
     WHERE started_at >= @from AND started_at < @to
     ORDER BY started_at ASC`,
  );

  const perModelStmt = db.prepare<
    { from: number },
    {
      model: string | null;
      tokensIn: number;
      tokensOut: number;
      sessions: number;
    }
  >(
    `SELECT model,
            COALESCE(SUM(tokens_input), 0) AS tokensIn,
            COALESCE(SUM(tokens_output), 0) AS tokensOut,
            COUNT(*) AS sessions
     FROM sessions
     WHERE started_at >= @from
     GROUP BY model
     ORDER BY (COALESCE(SUM(tokens_input), 0) + COALESCE(SUM(tokens_output), 0)) DESC`,
  );

  const totalsBetweenStmt = db.prepare<
    { from: number; to: number },
    { tokensIn: number; tokensOut: number; sessions: number }
  >(
    `SELECT COALESCE(SUM(tokens_input), 0)  AS tokensIn,
            COALESCE(SUM(tokens_output), 0) AS tokensOut,
            COUNT(*) AS sessions
     FROM sessions
     WHERE started_at >= @from AND started_at < @to`,
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
      // Defense-in-depth: TypeScript enforces the key set at compile time,
      // but a future untyped caller passing an arbitrary object would inject
      // whatever key they want as a column name. Allowlist the keys
      // explicitly against the DB column set before splicing them into SQL.
      const keys = (Object.keys(patch) as string[]).filter((k) =>
        (ALLOWED_SESSION_UPDATE_KEYS as readonly string[]).includes(k),
      );
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
    remove(id) {
      // Wrap in a transaction so a partial failure (e.g. broken DB write
      // mid-statement) leaves the row set consistent — either the session
      // and all its dependents are gone, or nothing is.
      const tx = db.transaction((sessionId: string) => {
        // messages cascade via FK ON DELETE CASCADE — count first so the
        // caller can audit + show "deleted N messages".
        const msgCount = db
          .prepare<{ id: string }, { n: number }>(
            `SELECT COUNT(*) AS n FROM messages WHERE session_id = @id`,
          )
          .get({ id: sessionId });
        const proposalCount = db
          .prepare<{ id: string }, { n: number }>(
            `SELECT COUNT(*) AS n FROM memory_proposals WHERE session_id = @id`,
          )
          .get({ id: sessionId });
        const emailCount = db
          .prepare<{ id: string }, { n: number }>(
            `SELECT COUNT(*) AS n FROM pending_email_sends
             WHERE propose_session_id = @id OR commit_session_id = @id`,
          )
          .get({ id: sessionId });

        db.prepare(`DELETE FROM memory_proposals WHERE session_id = @id`).run({
          id: sessionId,
        });
        db.prepare(
          `DELETE FROM pending_email_sends
           WHERE propose_session_id = @id OR commit_session_id = @id`,
        ).run({ id: sessionId });
        const sessionResult = db
          .prepare(`DELETE FROM sessions WHERE id = @id`)
          .run({ id: sessionId });

        return {
          session: sessionResult.changes,
          messages: msgCount?.n ?? 0,
          proposals: proposalCount?.n ?? 0,
          emailSends: emailCount?.n ?? 0,
        };
      });
      return tx(id);
    },
    tokensUsedBetween(fromMs, toMs) {
      const row = tokensSum.get({ from: fromMs, to: toMs });
      return row?.total ?? 0;
    },
    tokensUsedSince(fromMs) {
      const row = tokensSum.get({ from: fromMs, to: Number.MAX_SAFE_INTEGER });
      return row?.total ?? 0;
    },
    dailyRaw(fromMs, toMs) {
      return dailyRawStmt.all({ from: fromMs, to: toMs });
    },
    perModelTotals(fromMs) {
      return perModelStmt.all({ from: fromMs });
    },
    totalsBetween(fromMs, toMs) {
      return (
        totalsBetweenStmt.get({ from: fromMs, to: toMs }) ?? {
          tokensIn: 0,
          tokensOut: 0,
          sessions: 0,
        }
      );
    },
  };
}
