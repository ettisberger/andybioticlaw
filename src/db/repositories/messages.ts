import type { Database } from 'better-sqlite3';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageRecord {
  id: number;
  session_id: string;
  chat_id: string;
  role: MessageRole;
  content: string;
  telegram_message_id: number | null;
  created_at: number;
}

export interface InsertMessageInput {
  session_id: string;
  chat_id: string;
  role: MessageRole;
  content: string;
  telegram_message_id?: number | null;
}

export interface MessagesRepo {
  insert(input: InsertMessageInput): number;
  setTelegramMessageId(id: number, telegramMessageId: number): void;
  latestByChat(chatId: string, limit: number): MessageRecord[];
  byChatSince(chatId: string, sinceMs: number): MessageRecord[];
}

export function createMessagesRepo(db: Database): MessagesRepo {
  const insert = db.prepare(
    `INSERT INTO messages (session_id, chat_id, role, content, telegram_message_id, created_at)
     VALUES (@session_id, @chat_id, @role, @content, @telegram_message_id, @created_at)`,
  );

  const updateTgId = db.prepare<{ id: number; tg: number }>(
    `UPDATE messages SET telegram_message_id = @tg WHERE id = @id`,
  );

  const latest = db.prepare<{ chat_id: string; limit: number }, MessageRecord>(
    `SELECT * FROM messages WHERE chat_id = @chat_id ORDER BY created_at DESC, id DESC LIMIT @limit`,
  );

  const since = db.prepare<{ chat_id: string; ts: number }, MessageRecord>(
    `SELECT * FROM messages WHERE chat_id = @chat_id AND created_at >= @ts ORDER BY created_at ASC, id ASC`,
  );

  return {
    insert(input) {
      const result = insert.run({
        session_id: input.session_id,
        chat_id: input.chat_id,
        role: input.role,
        content: input.content,
        telegram_message_id: input.telegram_message_id ?? null,
        created_at: Date.now(),
      });
      return Number(result.lastInsertRowid);
    },
    setTelegramMessageId(id, telegramMessageId) {
      updateTgId.run({ id, tg: telegramMessageId });
    },
    latestByChat(chatId, limit) {
      const rows = latest.all({ chat_id: chatId, limit });
      return rows.reverse();
    },
    byChatSince(chatId, sinceMs) {
      return since.all({ chat_id: chatId, ts: sinceMs });
    },
  };
}
