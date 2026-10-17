// Contactos (docs/01 §6): a pessoa/número. Consentimento e opt-out obrigatórios
// antes de qualquer campanha (docs/04 §7).

import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── contacts ─────────────

export const contacts = pgTable(
  'contacts',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    // E.164 (+244…): normalização e máscara numa única função testada (docs/02 §2).
    // Fixo R17 (Task 5): a unicidade é POR TENANT — o mesmo número a escrever a
    // dois clientes da MilVendas são DUAS linhas de contacto distintas. Um
    // unique global devolveria o contacto de um tenant ao job do outro.
    phoneE164: text('phone_e164').notNull(),
    name: text('name'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentAt: ts('consent_at'),
    consentSource: text('consent_source'), // livre: onde/ quando o consentimento foi dado
    optedOutAt: ts('opted_out_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Fixo R17 (Task 5): `phone_e164` único POR TENANT (espelho do composto da
    // outbox) — a mesma linha de upsert em `findOrCreateContact` é scoped e o
    // job de B nunca recebe o contacto de A.
    uniqueIndex('contacts_tenant_phone_unique').on(t.tenantId, t.phoneE164),
    // Audiência de campanha: marketing_consent = true e opted_out_at is null
    // (docs/04 §7).
    index('contacts_consent_optout_idx').on(t.marketingConsent, t.optedOutAt),
    // Listagem por tenant (spec §4.2): (tenant_id) + composto por data.
    index('contacts_tenant_idx').on(t.tenantId),
    index('contacts_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);
