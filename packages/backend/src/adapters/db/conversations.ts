// Repositório de conversas/mensagens (Task 21): paginação keyset opaca por
// cursor `base64url({ t, id })` (docs/02 §5) — sem OFFSET, estável sob escritas
// concorrentes (o par (timestamp, id) é total e determinístico). SELECT
// explícito de colunas (sem SELECT *); junção ao contacto para o telefone.

import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from '../../domain/error.js';
import type { ConversationsRepository, MessageView } from '../../ports/conversations.js';
import type { DbClient } from './index.js';
import { contacts } from './schema/contacts.schema.js';
import { conversations } from './schema/conversations.schema.js';
import { messages } from './schema/messages.schema.js';
import { outboxMessages } from './schema/outbox.schema.js';

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

function encodeCursor(t: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: Date; id: string } {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { t: new Date(parsed.t), id: parsed.id };
  } catch {
    throw new DomainError('invalid_cursor');
  }
}

// Conversa ordenada pela actividade: last_message_at é NULO em conversas sem
// mensagens e o Postgres põe os NULLs primeiro em DESC — sem COALESCE, um
// cursor com t nulo daria comparação de par NULL e a paginação perderia tudo
// o que viesse depois (>=50 conversas sem mensagens). created_at cobre o nulo.
const lastActivity = (c: typeof conversations) => sql`COALESCE(${c.lastMessageAt}, ${c.createdAt})`;

const convSelect = {
  id: conversations.id,
  accountId: conversations.accountId,
  contactId: conversations.contactId,
  leadId: conversations.leadId,
  line: conversations.lineId,
  aiMode: conversations.aiMode,
  missStreak: conversations.missStreak,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  contactPhone: contacts.phoneE164,
};

const msgSelect = {
  id: messages.id,
  conversationId: messages.conversationId,
  direction: messages.direction,
  sender: messages.sender,
  kind: messages.kind,
  body: messages.body,
  status: messages.status,
  mediaRef: messages.mediaRef,
  createdAt: messages.createdAt,
};

function toMessageView(row: {
  id: string;
  conversationId: string;
  direction: MessageView['direction'];
  sender: MessageView['sender'];
  kind: string;
  body: string | null;
  status: MessageView['status'];
  mediaRef: string | null;
  createdAt: Date;
}): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    sender: row.sender,
    kind: row.kind,
    body: row.body ?? '',
    status: row.status,
    mediaRef: row.mediaRef,
    createdAt: row.createdAt,
  };
}

export function createConversationsRepository(db: DbClient): ConversationsRepository {
  return {
    async list(input) {
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      const conditions = [
        input.accountId === undefined ? undefined : eq(conversations.accountId, input.accountId),
        cursor === null
          ? undefined
          : sql`(${lastActivity(conversations)}, ${conversations.id}) < (${cursor.t}, ${cursor.id})`,
      ];
      const rows = await db
        .select(convSelect)
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(and(...conditions))
        .orderBy(sql`${lastActivity(conversations)} DESC, ${conversations.id} DESC`)
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last.lastMessageAt ?? last.createdAt, last.id) : null,
      };
    },

    async get(id) {
      const [conv] = await db
        .select(convSelect)
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(eq(conversations.id, id))
        .limit(1);
      if (conv === undefined) return null;
      const [last] = await db
        .select(msgSelect)
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      return { conversation: conv, lastMessage: last === undefined ? null : toMessageView(last) };
    },

    async listMessages(input) {
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      const conditions = [
        eq(messages.conversationId, input.conversationId),
        cursor === null
          ? undefined
          : sql`(${messages.createdAt}, ${messages.id}) < (${cursor.t}, ${cursor.id})`,
      ];
      const rows = await db
        .select(msgSelect)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(toMessageView);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async getMessageByOutbox(outboxId) {
      const [row] = await db
        .select(msgSelect)
        .from(outboxMessages)
        .innerJoin(messages, eq(messages.id, outboxMessages.messageId))
        .where(eq(outboxMessages.id, outboxId))
        .limit(1);
      return row === undefined ? null : toMessageView(row);
    },
  };
}
