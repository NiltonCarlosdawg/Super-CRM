// Auditoria (docs/01 §6): quem fez o quê e quando — ações humanas E da IA.
// Tabela só-de-inserção: sem updated_at (padrão das tabelas append-only do
// knowledge.schema.ts).

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema.js';

// ───────────── Helpers (padrão knowledge.schema.ts) ─────────────

const pk = () => uuid('id').defaultRandom().primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();

// ───────────── audit_log ─────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    actorId: uuid('actor_id').references(() => users.id), // nulo = ação da IA/sistema
    action: text('action').notNull(), // PERGUNTA DO GATE: ex.: 'auth.login', 'campaign.started'
    entityId: uuid('entity_id'), // entidade afetada (lead, campanha, contacto…)
    ip: text('ip'), // IPv4/IPv6 como texto; sem segredos (docs/03)
    details: jsonb('details'), // detalhe adicional (nunca palavras-passe)
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt), // listagem recente por cursor
    index('audit_log_actor_idx').on(t.actorId), // o que fez este utilizador
    index('audit_log_entity_idx').on(t.entityId), // histórico de uma entidade
  ],
);
