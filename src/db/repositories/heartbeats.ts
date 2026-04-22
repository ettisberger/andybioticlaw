import type { Database } from 'better-sqlite3';

export interface HeartbeatMeta {
  active_sessions: number;
  queue_depths: Record<string, number>;
  [k: string]: unknown;
}

export interface HeartbeatsRepo {
  write(meta: HeartbeatMeta): void;
  latest(): { at: number; meta: HeartbeatMeta } | null;
  deleteOlderThan(cutoffMs: number): number;
}

export function createHeartbeatsRepo(db: Database): HeartbeatsRepo {
  const insert = db.prepare('INSERT INTO heartbeats (at, meta) VALUES (@at, @meta)');
  const selectLatest = db.prepare<[], { at: number; meta: string | null }>(
    'SELECT at, meta FROM heartbeats ORDER BY at DESC LIMIT 1',
  );
  const deleteOld = db.prepare<{ cutoff: number }>('DELETE FROM heartbeats WHERE at < @cutoff');

  return {
    write(meta) {
      insert.run({ at: Date.now(), meta: JSON.stringify(meta) });
    },
    latest() {
      const row = selectLatest.get();
      if (!row) return null;
      return {
        at: row.at,
        meta: row.meta ? (JSON.parse(row.meta) as HeartbeatMeta) : ({
          active_sessions: 0,
          queue_depths: {},
        } as HeartbeatMeta),
      };
    },
    deleteOlderThan(cutoffMs) {
      return deleteOld.run({ cutoff: cutoffMs }).changes;
    },
  };
}
