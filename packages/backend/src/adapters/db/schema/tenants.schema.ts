// Tenants (Onda 1, multitenancy — spec docs/superpowers/specs/2026-10-16-multitenant-design.md §4.1):
// um tenant = uma empresa cliente. Todas as tabelas de negócio ganham
// `tenant_id` (§4.2); `sessions` e `business_lines` ficam intocadas (infra de
// auth / dicionário global — justificação na spec §4.2).

import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenantStatusEnum } from './enums.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// Id fixo do tenant "MilVendas" (R3): os dados existentes migram para ele no
// backfill da migração 0004 e o literal é citado nos docs. Enquanto os
// services não derivam tenant_id da sessão (Onda 1, Tasks 3–5), os inserts
// existentes usam este tenant — não é um DEFAULT da BD.
export const MILVENDAS_TENANT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// ───────────── tenants ─────────────

export const tenants = pgTable('tenants', {
  id: pk(),
  name: text('name').notNull(),
  status: tenantStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
