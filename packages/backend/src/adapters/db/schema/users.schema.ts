// Equipa interna (docs/01 §6): role, active, hash de palavra-passe.
// totp_secret/totp_enabled_at entram na Fase 1 (docs/plans/...fase1, Task 1).

import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums.js';

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
  name: text('name').notNull(),
  // Normalização (lower+trim) na fronteira antes do insert (docs/02 §3).
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // argon2id, nunca em claro (docs/03)
  role: userRoleEnum('role').notNull(), // admin | editor | agent — sem default: o papel é sempre explícito
  active: boolean('active').notNull().default(true), // docs/01 §6
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
