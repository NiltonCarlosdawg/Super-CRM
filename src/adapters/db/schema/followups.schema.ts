// Follow-ups (docs/05 §9): sequência por linha, passos com atraso/conteúdo e
// execução por lead. Os vocabulários de condition, content_mode, status e
// stop_reason não estão definidos nos docs: ficam como text e são perguntas do
// gate (docs/schema-base.md). O máximo de 3 passos é valor inicial a confirmar
// pelo dono do produto (docs/05 §9) — não está fechado em CHECK.

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businessLines } from '../../../modules/knowledge/knowledge.schema.js';
import { contacts } from './contacts.schema.js';
import { conversations } from './conversations.schema.js';
import { leads } from './leads.schema.js';
import { users } from './users.schema.js';
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

// ───────────── followup_sequences ─────────────

export const followupSequences = pgTable(
  'followup_sequences',
  {
    id: pk(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => businessLines.id), // sequência por linha (docs/05 §9)
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('followup_sequences_line_name_uq').on(t.lineId, t.name)],
);

// ───────────── followup_steps ─────────────

export const followupSteps = pgTable(
  'followup_steps',
  {
    id: pk(),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => followupSequences.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(), // contígua a partir de 1
    delayHours: integer('delay_hours').notNull(), // desde o fim do passo anterior
    condition: text('condition').notNull(), // PERGUNTA DO GATE: vocabulário
    // Modelo pronto ou geração pela IA dentro das regras (docs/05 §9).
    contentMode: text('content_mode').notNull(), // PERGUNTA DO GATE: vocabulário
    templateText: text('template_text'), // exige-se quando content_mode = template (Fase 5)
    aiPrompt: text('ai_prompt'), // exige-se quando content_mode = ai (Fase 5)
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('followup_steps_sequence_position_uq').on(t.sequenceId, t.position),
    check('followup_steps_delay_ck', sql`delay_hours > 0`),
  ],
);

// ───────────── followup_runs ─────────────

export const followupRuns = pgTable(
  'followup_runs',
  {
    id: pk(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => followupSequences.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    status: text('status').notNull(), // PERGUNTA DO GATE: estados de followup_runs
    stopReason: text('stop_reason'), // PERGUNTA DO GATE: vocabulário (docs/05 §9)
    currentStep: integer('current_step').notNull().default(0), // 0 = nenhum passo enviado
    nextRunAt: ts('next_run_at').notNull(),
    lastSentAt: ts('last_sent_at'),
    pendingText: text('pending_text'), // em ai_suggest, aguarda aprovação (docs/05 §9, D13)
    pendingTraceId: uuid('pending_trace_id'),
    startedAt: ts('started_at').notNull().defaultNow(),
    stoppedAt: ts('stopped_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Execuções devidas: estado + próxima execução.
    index('followup_runs_due_idx').on(t.status, t.nextRunAt),
    index('followup_runs_lead_idx').on(t.leadId),
    index('followup_runs_conversation_idx').on(t.conversationId),
    index('followup_runs_account_idx').on(t.accountId),
  ],
);
