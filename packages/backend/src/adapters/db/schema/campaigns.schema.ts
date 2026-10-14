// Campanhas (docs/01 §6): modelo de mensagem com variáveis, contas permitidas,
// limites, estado por destinatário. As contas permitidas são a junção
// campaign_accounts (decisão de design, docs/schema-base.md).

import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { campaignRecipientStatusEnum, campaignStatusEnum } from './enums.js';
import { contacts } from './contacts.schema.js';
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

// ───────────── campaigns ─────────────

export const campaigns = pgTable(
  'campaigns',
  {
    id: pk(),
    name: text('name').notNull(),
    messageTemplate: text('message_template').notNull(), // modelo com variáveis (docs/01 §6)
    status: campaignStatusEnum('status').notNull().default('draft'),
    // PERGUNTA DO GATE: colunas de limites em campaigns (docs/schema-base.md).
    dailyLimit: integer('daily_limit'), // por conta, por dia; null = só a config global/ramp
    scheduledAt: ts('scheduled_at'),
    createdBy: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('campaigns_status_idx').on(t.status)],
);

// ───────────── campaign_recipients ─────────────

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: pk(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    step: integer('step').notNull().default(1), // passo da sequência (follow-ups na Fase 5)
    status: campaignRecipientStatusEnum('status').notNull().default('pending'),
    outboxKey: text('outbox_key'), // idempotency_key da linha de outbox correspondente
    enqueuedAt: ts('enqueued_at'),
    repliedAt: ts('replied_at'),
    optedOutAt: ts('opted_out_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Evita duplicar o mesmo destinatário no mesmo passo (docs/01 §6).
    uniqueIndex('campaign_recipients_delivery_uq').on(t.campaignId, t.contactId, t.step),
    // Envio por conta com estado do destinatário.
    index('campaign_recipients_account_status_idx').on(t.accountId, t.status, t.enqueuedAt),
    index('campaign_recipients_campaign_status_idx').on(t.campaignId, t.status),
  ],
);

// ───────────── campaign_accounts ─────────────

// "Contas permitidas" de cada campanha (docs/01 §6) como junção normalizada em
// vez de array (integridade na base por FK + UNIQUE, docs/02 §5).
export const campaignAccounts = pgTable(
  'campaign_accounts',
  {
    id: pk(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => whatsappAccounts.id),
    createdAt: createdAt(), // junção estável: sem updated_at
  },
  (t) => [
    uniqueIndex('campaign_accounts_uq').on(t.campaignId, t.accountId),
    // Consulta inversa: que campanhas usam esta conta?
    index('campaign_accounts_account_idx').on(t.accountId),
  ],
);
