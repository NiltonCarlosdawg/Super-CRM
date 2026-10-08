// Contactos (docs/01 §6): a pessoa/número. Consentimento e opt-out obrigatórios
// antes de qualquer campanha (docs/04 §7).

import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
    // E.164 (+244…): normalização e máscara numa única função testada (docs/02 §2).
    phoneE164: text('phone_e164').notNull().unique(),
    name: text('name'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentAt: ts('consent_at'),
    consentSource: text('consent_source'), // livre: onde/ quando o consentimento foi dado
    optedOutAt: ts('opted_out_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Audiência de campanha: marketing_consent = true e opted_out_at is null
    // (docs/04 §7).
    index('contacts_consent_optout_idx').on(t.marketingConsent, t.optedOutAt),
  ],
);
