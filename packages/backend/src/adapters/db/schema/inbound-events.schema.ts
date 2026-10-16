// Caixa de entrada de webhooks (docs/01 §6): garante idempotência da receção —
// provider_event_id único. `received_at` é o momento da receção (é o timestamp
// de criação desta tabela; não há created_at separado para não duplicar o facto).

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ───────────── inbound_events ─────────────

export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: pk(),
    // Onda 1 (spec §4.2): ANULÁVEL — o evento é gravado antes de resolver a
    // conta; preenchido no job inbound.process quando a conta resolve.
    tenantId: uuid('tenant_id').references(() => tenants.id),
    providerEventId: text('provider_event_id').notNull().unique(), // idempotência do webhook (docs/01 §6)
    payload: jsonb('payload').notNull(), // payload bruto validado na fronteira (docs/02 §3)
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'), // nulo = pendente de processar
    // Claim de idempotência do processamento (Fase 1 Task 20; consumido pela
    // Fase 3): nulo = ainda não reclamado por um job.
    aiClaimedAt: ts('ai_claimed_at'),
  },
  (t) => [
    // Fila de pendentes: só eventos por processar, ordenados por chegada
    // (índice parcial exigido pela Task 9).
    index('inbound_events_pending_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
    // Listagem por tenant (spec §4.2): (tenant_id) + composto por received_at
    // (a tabela não tem created_at; received_at é o seu momento de criação).
    index('inbound_events_tenant_idx').on(t.tenantId),
    index('inbound_events_tenant_received_idx').on(t.tenantId, t.receivedAt),
  ],
);
