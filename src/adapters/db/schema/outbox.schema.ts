// Mensagens a enviar (docs/01 §6). Transação: caso de uso → grava mensagem
// (estado 'queued') + linha na outbox → fila envia com limites (docs/04 §7).
// Nunca se chama send() fora da outbox + fila.

import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { outboxStatusEnum } from './enums.js';
import { messages } from './messages.schema.js';
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

// ───────────── outbox_messages ─────────────

export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: pk(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    idempotencyKey: text('idempotency_key').notNull().unique(), // re-envio com a mesma chave não duplica
    // 1 = resposta de conversa, 2 = campanha (docs/04 §7: resposta primeiro).
    priority: integer('priority').notNull().default(1),
    scheduledAt: ts('scheduled_at').notNull().defaultNow(), // claim só lê scheduled_at <= now
    attempts: integer('attempts').notNull().default(0),
    status: outboxStatusEnum('status').notNull().default('queued'),
    lastError: text('last_error'), // último erro de envio, para diagnóstico
    createdAt: createdAt(),
    updatedAt: updatedAt(), // o sweep de linhas 'sending' velhas usa updated_at
  },
  (t) => [
    // Claim do worker: status = queued, ordenado por priority, scheduled_at
    // (FOR UPDATE SKIP LOCKED na query, docs/02 §6).
    index('outbox_messages_claim_idx').on(t.status, t.priority, t.scheduledAt),
    // Contagem de pendentes da conta: filas 'queued' + 'sending'
    // (docs/plans/2026-10-07-fase1-nucleo-whatsapp.md, Task 18).
    index('outbox_messages_account_status_idx').on(t.accountId, t.status),
  ],
);
