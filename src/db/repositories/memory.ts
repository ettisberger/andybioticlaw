import type { Database } from 'better-sqlite3';

export type MemorySource = 'manual' | 'inferred' | 'agent' | 'proposal_accepted';

export interface MemoryRecord {
  id: number;
  scope: string;
  key: string | null;
  value: string;
  source: MemorySource;
  ttl_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateMemoryInput {
  scope: string;
  value: string;
  key?: string | null;
  source: MemorySource;
  ttl_at?: number | null;
}

export interface ProposalRecord {
  id: number;
  session_id: string;
  chat_id: string;
  scope: string;
  proposed_value: string;
  proposed_key: string | null;
  ttl_seconds: number | null;
  status: 'pending' | 'accepted' | 'dismissed' | 'expired';
  created_at: number;
  decided_at: number | null;
  committed_memory_id: number | null;
  telegram_button_message_id: number | null;
  telegram_chat_id: string | null;
}

export interface CreateProposalInput {
  session_id: string;
  chat_id: string;
  scope: string;
  proposed_value: string;
  proposed_key?: string | null;
  ttl_seconds?: number | null;
}

export interface MemoryRepo {
  create(input: CreateMemoryInput): MemoryRecord;
  update(id: number, patch: { value?: string; key?: string | null; ttl_at?: number | null }): void;
  remove(id: number): boolean;
  get(id: number): MemoryRecord | null;
  list(opts?: { scope?: string; limit?: number }): MemoryRecord[];
  listActive(scopes: string[], now?: number): MemoryRecord[];
  deleteExpired(now: number): number;

  proposalCreate(input: CreateProposalInput): ProposalRecord;
  proposalGet(id: number): ProposalRecord | null;
  proposalListPending(sessionId: string): ProposalRecord[];
  proposalSetButton(id: number, telegramChatId: string, telegramMessageId: number): void;
  proposalAccept(id: number, committedMemoryId: number): void;
  proposalDismiss(id: number): void;
  proposalMarkExpired(olderThanMs: number): number;
}

/** Allowlist of columns accepted by `MemoryRepo.update()` — interpolated
 *  into SQL, so must be checked at runtime. */
const ALLOWED_MEMORY_UPDATE_KEYS = ['value', 'key', 'ttl_at'] as const;

export function createMemoryRepo(db: Database): MemoryRepo {
  const insertMemory = db.prepare(
    `INSERT INTO memory (scope, key, value, source, ttl_at, created_at, updated_at)
     VALUES (@scope, @key, @value, @source, @ttl_at, @created_at, @updated_at)`,
  );

  const selectMemory = db.prepare<{ id: number }, MemoryRecord>(
    `SELECT * FROM memory WHERE id = @id`,
  );

  const selectByScope = db.prepare<{ scope: string; limit: number }, MemoryRecord>(
    `SELECT * FROM memory WHERE scope = @scope ORDER BY updated_at DESC LIMIT @limit`,
  );

  const selectAll = db.prepare<{ limit: number }, MemoryRecord>(
    `SELECT * FROM memory ORDER BY updated_at DESC LIMIT @limit`,
  );

  const deleteById = db.prepare<{ id: number }>(`DELETE FROM memory WHERE id = @id`);

  const deleteExpired = db.prepare<{ now: number }>(
    `DELETE FROM memory WHERE ttl_at IS NOT NULL AND ttl_at < @now`,
  );

  const insertProposal = db.prepare(
    `INSERT INTO memory_proposals (session_id, chat_id, scope, proposed_value, proposed_key, ttl_seconds, status, created_at)
     VALUES (@session_id, @chat_id, @scope, @proposed_value, @proposed_key, @ttl_seconds, 'pending', @created_at)`,
  );

  const selectProposal = db.prepare<{ id: number }, ProposalRecord>(
    `SELECT * FROM memory_proposals WHERE id = @id`,
  );

  const selectPendingBySession = db.prepare<{ session_id: string }, ProposalRecord>(
    `SELECT * FROM memory_proposals WHERE session_id = @session_id AND status = 'pending' ORDER BY created_at ASC`,
  );

  const setProposalButton = db.prepare<{
    id: number;
    telegram_chat_id: string;
    telegram_button_message_id: number;
  }>(
    `UPDATE memory_proposals SET telegram_chat_id = @telegram_chat_id, telegram_button_message_id = @telegram_button_message_id WHERE id = @id`,
  );

  const acceptProposal = db.prepare<{ id: number; committed: number; decided: number }>(
    `UPDATE memory_proposals SET status = 'accepted', decided_at = @decided, committed_memory_id = @committed WHERE id = @id AND status = 'pending'`,
  );

  const dismissProposal = db.prepare<{ id: number; decided: number }>(
    `UPDATE memory_proposals SET status = 'dismissed', decided_at = @decided WHERE id = @id AND status = 'pending'`,
  );

  const expireProposals = db.prepare<{ cutoff: number }>(
    `UPDATE memory_proposals SET status = 'expired' WHERE status = 'pending' AND created_at < @cutoff`,
  );

  return {
    create(input) {
      const now = Date.now();
      const result = insertMemory.run({
        scope: input.scope,
        key: input.key ?? null,
        value: input.value,
        source: input.source,
        ttl_at: input.ttl_at ?? null,
        created_at: now,
        updated_at: now,
      });
      const row = selectMemory.get({ id: Number(result.lastInsertRowid) });
      if (!row) throw new Error('memory insert succeeded but row not found — impossible');
      return row;
    },
    update(id, patch) {
      // Allowlist-guarded key set. Patch values go through parameter
      // binding, but keys are interpolated into SQL — so we filter them
      // against an explicit column set first.
      const keys = (Object.keys(patch) as string[]).filter((k) =>
        (ALLOWED_MEMORY_UPDATE_KEYS as readonly string[]).includes(k),
      );
      if (keys.length === 0) return;
      const sets = keys.map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE memory SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
        id,
        updated_at: Date.now(),
        ...patch,
      });
    },
    remove(id) {
      return deleteById.run({ id }).changes > 0;
    },
    get(id) {
      return selectMemory.get({ id }) ?? null;
    },
    list({ scope, limit = 100 } = {}) {
      return scope ? selectByScope.all({ scope, limit }) : selectAll.all({ limit });
    },
    listActive(scopes, now = Date.now()) {
      if (scopes.length === 0) return [];
      const placeholders = scopes.map((_, i) => `@s${i}`).join(',');
      const params: Record<string, unknown> = { now };
      scopes.forEach((s, i) => {
        params[`s${i}`] = s;
      });
      const stmt = db.prepare<Record<string, unknown>, MemoryRecord>(
        `SELECT * FROM memory
         WHERE scope IN (${placeholders})
           AND (ttl_at IS NULL OR ttl_at >= @now)
         ORDER BY updated_at DESC`,
      );
      return stmt.all(params);
    },
    deleteExpired(now) {
      return deleteExpired.run({ now }).changes;
    },
    proposalCreate(input) {
      const now = Date.now();
      const result = insertProposal.run({
        session_id: input.session_id,
        chat_id: input.chat_id,
        scope: input.scope,
        proposed_value: input.proposed_value,
        proposed_key: input.proposed_key ?? null,
        ttl_seconds: input.ttl_seconds ?? null,
        created_at: now,
      });
      const row = selectProposal.get({ id: Number(result.lastInsertRowid) });
      if (!row) throw new Error('proposal insert succeeded but row not found — impossible');
      return row;
    },
    proposalGet(id) {
      return selectProposal.get({ id }) ?? null;
    },
    proposalListPending(sessionId) {
      return selectPendingBySession.all({ session_id: sessionId });
    },
    proposalSetButton(id, telegramChatId, telegramMessageId) {
      setProposalButton.run({
        id,
        telegram_chat_id: telegramChatId,
        telegram_button_message_id: telegramMessageId,
      });
    },
    proposalAccept(id, committedMemoryId) {
      acceptProposal.run({ id, committed: committedMemoryId, decided: Date.now() });
    },
    proposalDismiss(id) {
      dismissProposal.run({ id, decided: Date.now() });
    },
    proposalMarkExpired(olderThanMs) {
      return expireProposals.run({ cutoff: olderThanMs }).changes;
    },
  };
}
