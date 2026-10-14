// Caixa de entrada de webhooks (docs/01 §6): garante idempotência da receção —
// provider_event_id único. `received_at` é o momento da receção (é o timestamp
// de criação desta tabela; não há created_at separado para não duplicar o facto).

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ───────────── inbound_events ─────────────

export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: pk(),
    providerEventId: text('provider_event_id').notNull().unique(), // idempotência do webhook (docs/01 §6)
    payload: jsonb('payload').notNull(), // payload bruto validado na fronteira (docs/02 §3)
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'), // nulo = pendente de processar
  },
  (t) => [
    // Fila de pendentes: só eventos por processar, ordenados por chegada
    // (índice parcial exigido pela Task 9).
    index('inbound_events_pending_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);
