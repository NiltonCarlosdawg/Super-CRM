// Contas WhatsApp (docs/01 §6, docs/04 §6): uma conta = uma sessão no WA-AKG.
// O WA-AKG é acessado sempre pelo adaptador MessagingProvider (docs/04 §1).

import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { whatsappAccountStatusEnum, whatsappPurposeEnum } from './enums.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── whatsapp_accounts ─────────────

export const whatsappAccounts = pgTable(
  'whatsapp_accounts',
  {
    id: pk(),
    label: text('label').notNull(),
    // E.164 (+244…): normalização e máscara numa única função testada (docs/02 §2).
    phoneE164: text('phone_e164').notNull().unique(),
    provider: text('provider').notNull().default('wa-akg'), // fornecedor único desta fase (docs/01 §6)
    providerSessionId: text('provider_session_id').notNull().unique(), // id da sessão no WA-AKG
    status: whatsappAccountStatusEnum('status').notNull().default('connecting'), // docs/04 §6
    purpose: whatsappPurposeEnum('purpose').notNull(), // support | sales | campaigns (docs/04 §6)
    // Limite diário próprio da conta; null = só a config global (WA_CAMPAIGN_RAMP…).
    dailySendCap: integer('daily_send_cap'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('whatsapp_accounts_status_idx').on(t.status),
    index('whatsapp_accounts_purpose_idx').on(t.purpose), // campanhas só usam contas campaigns
  ],
);
