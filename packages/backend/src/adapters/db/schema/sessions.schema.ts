// Sessões server-side em PostgreSQL (A2, docs/06 §A2): cookie HttpOnly + CSRF
// double-submit. A PK é o valor do cookie (randomUUID() gerado pela aplicação);
// logout/revogação = DELETE da linha (docs/plans/...fase1, Task 15).

import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── sessions ─────────────

export const sessions = pgTable(
  'sessions',
  {
    id: pk(), // a aplicação fornece randomUUID(): este valor é o cookie de sessão
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: ts('expires_at').notNull(), // now + ttl; sessão expirada nunca é aceite
    createdAt: createdAt(),
    updatedAt: updatedAt(), // mfa_pending (Fase 1) atualiza a linha
  },
  (t) => [
    index('sessions_user_idx').on(t.userId), // revogação todas as sessões de um utilizador
    index('sessions_expires_idx').on(t.expiresAt), // limpeza de expiradas
  ],
);
