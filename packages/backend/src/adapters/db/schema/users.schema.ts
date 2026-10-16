// Equipa interna (docs/01 §6): role, active, hash de palavra-passe,
// totp_secret/totp_enabled_at (Fase 1, Task 1/8).

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums.js';
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

// ───────────── users ─────────────

export const users = pgTable('users', {
  id: pk(),
  // Onda 1: scoping por tenant (spec §4.2). Anulável só para platform_admin —
  // a invariante (role = 'platform_admin') = (tenant_id IS NULL) é garantida
  // pelo CHECK users_platform_tenant_check (Task 2, spec §4.3).
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  // Normalização (lower+trim) na fronteira antes do insert (docs/02 §3).
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // argon2id, nunca em claro (docs/03)
  role: userRoleEnum('role').notNull(), // admin | editor | agent | platform_admin — sem default: o papel é sempre explícito
  active: boolean('active').notNull().default(true), // docs/01 §6
  // TOTP para `admin` (Fase 1 Task 8): blob AES-GCM, nulo até ativar.
  totpSecret: text('totp_secret'),
  totpEnabledAt: ts('totp_enabled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, () => [
  // Onda 1, Task 2 (spec §4.3): platform_admin É a plataforma (tenant_id NULL);
  // todos os outros papéis pertencem a um tenant. Invariante do Postgres.
  check('users_platform_tenant_check', sql`((role = 'platform_admin') = (tenant_id IS NULL))`),
]);
