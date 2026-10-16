// Equipa interna (docs/01 §6): role, active, hash de palavra-passe,
// totp_secret/totp_enabled_at (Fase 1, Task 1/8).

import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
  name: text('name').notNull(),
  // Normalização (lower+trim) na fronteira antes do insert (docs/02 §3).
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // argon2id, nunca em claro (docs/03)
  role: userRoleEnum('role').notNull(), // admin | editor | agent — sem default: o papel é sempre explícito
  active: boolean('active').notNull().default(true), // docs/01 §6
  // TOTP para `admin` (Fase 1 Task 8): blob AES-GCM, nulo até ativar.
  totpSecret: text('totp_secret'),
  totpEnabledAt: ts('totp_enabled_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
