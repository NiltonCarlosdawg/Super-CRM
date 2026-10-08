// Conversas (docs/01 §6): o fio de mensagens entre uma conta WhatsApp e um
// contacto. `line` do esboço é modelado como FK line_id → business_lines.
// `ai_mode` usa o enum único do módulo de conhecimento (fonte única do enum) e
// arranca em 'ai_suggest' por D13 (arranque da IA em modo sugestão).

import { index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { aiModeEnum, businessLines } from '../../../modules/knowledge/knowledge.schema.js';
import { contacts } from './contacts.schema.js';
import { leads } from './leads.schema.js';
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

// ───────────── conversations ─────────────

export const conversations = pgTable(
  'conversations',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    leadId: uuid('lead_id').references(() => leads.id), // ligado depois de o lead existir
    lineId: uuid('line_id').references(() => businessLines.id), // nulo até identificar a linha
    // Quem responde. Default ai_suggest = D13; mudar para ai_active exige gate.
    aiMode: aiModeEnum('ai_mode').notNull().default('ai_suggest'),
    missStreak: integer('miss_streak').notNull().default(0), // falhas seguidas da IA (docs/01 §6)
    lastMessageAt: ts('last_message_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Uma conversa por conta+contacto (necessária ao upsert da Fase 1 Task 19 e
    // ao findOrCreateForCampaign da Fase 4 — decisão registada em
    // docs/schema-base.md).
    uniqueIndex('conversations_account_contact_uq').on(t.accountId, t.contactId),
    // Paginação por cursor (docs/02 §5): listagem global por last_message_at.
    index('conversations_lastmsg_idx').on(t.lastMessageAt, t.id),
    // Listagem filtrada por conta, ordenada por last_message_at.
    index('conversations_account_lastmsg_idx').on(t.accountId, t.lastMessageAt),
    index('conversations_contact_idx').on(t.contactId),
  ],
);
