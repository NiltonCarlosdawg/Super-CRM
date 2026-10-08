// Lead = oportunidade numa linha de negócio (docs/01 §6).
// `line` do esboço é modelado como FK line_id → business_lines (decisão de design,
// docs/schema-base.md). Vocabulários de `stage` e `status` não estão definidos nos
// docs: ficam como text NOT NULL e são perguntas do gate (docs/schema-base.md).

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { businessLines } from '../../../modules/knowledge/knowledge.schema.js';
import { contacts } from './contacts.schema.js';
import { users } from './users.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── leads ─────────────

export const leads = pgTable(
  'leads',
  {
    id: pk(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    lineId: uuid('line_id').references(() => businessLines.id), // nulo até a linha estar identificada
    stage: text('stage').notNull(), // PERGUNTA DO GATE: vocabulário (docs/schema-base.md)
    status: text('status').notNull(), // PERGUNTA DO GATE: vocabulário do "estado" de docs/01 §6
    ownerId: uuid('owner_id').references(() => users.id), // anulável = sem dono atribuído
    qualification: jsonb('qualification').notNull().default('{}'), // respostas de qualificação (docs/01 §6)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('leads_contact_idx').on(t.contactId),
    index('leads_line_idx').on(t.lineId),
    index('leads_owner_idx').on(t.ownerId),
  ],
);
