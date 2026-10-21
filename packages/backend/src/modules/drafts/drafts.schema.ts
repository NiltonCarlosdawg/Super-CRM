// Rascunhos da IA (Fase 3, Task 2) — o modo `ai_suggest` gera rascunhos que um
// humano aprova/edita/rejeita antes de irem para a outbox (docs/05 §2).
//
// `tenant_id NOT NULL`: filho de `conversations` (escopado por tenant) — invariante
// da Onda 1 aplicada a uma tabela nova desta fase. Não é listado no contrato
// spec §4.2 da Onda 1 (que guarda as tabelas daquela spec); FK para `conversations`
// fica para a integração, tal como `handoffs.conversationId` (knowledge.schema).

import { jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { tenants } from '../../adapters/db/schema/tenants.schema.js';
import { createdAt, pk, ts, updatedAt } from '../knowledge/knowledge.schema.js';

export const draftStatusEnum = pgEnum('draft_status', [
  'pending',
  'approved',
  'edited',
  'rejected',
  'expired',
]);

export const aiDrafts = pgTable('ai_drafts', {
  id: pk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  conversationId: uuid('conversation_id').notNull(),
  traceId: uuid('trace_id'),
  text: text('text').notNull(),
  firedTriggers: jsonb('fired_triggers'),
  status: draftStatusEnum('status').notNull().default('pending'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  rejectedReason: text('rejected_reason'),
  outboxId: uuid('outbox_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
