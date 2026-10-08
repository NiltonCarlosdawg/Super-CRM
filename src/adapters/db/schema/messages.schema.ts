// Mensagens (docs/01 §6): direction, sender, tipo, corpo, provider_message_id
// único por conta, estado. Os estados só avançam (docs/04 §8).

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { messageDirectionEnum, messageKindEnum, messageSenderEnum, messageStatusEnum } from './enums.js';
import { conversations } from './conversations.schema.js';
import { whatsappAccounts } from './whatsapp-accounts.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── messages ─────────────

export const messages = pgTable(
  'messages',
  {
    id: pk(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    // Denormalizado para UNIQUE (account_id, provider_message_id) (docs/01 §6).
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    direction: messageDirectionEnum('direction').notNull(), // inbound | outbound
    sender: messageSenderEnum('sender').notNull(), // customer | ai | human | campaign
    kind: messageKindEnum('kind').notNull().default('text'), // docs/04 §5
    body: text('body'), // nulo = mídia sem legenda
    providerMessageId: text('provider_message_id'), // nulo até o WA-AKG aceitar o envio
    status: messageStatusEnum('status').notNull().default('queued'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "único por conta" (docs/01 §6); NULLs não conflitam no Postgres, por isso
    // mensagens ainda por enviar não bloqueiam umas às outras.
    uniqueIndex('messages_account_provider_uq').on(t.accountId, t.providerMessageId),
    // Paginação por cursor (docs/02 §5): conversa + created_at + id estável.
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt, t.id),
  ],
);
