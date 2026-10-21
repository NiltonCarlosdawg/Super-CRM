// Definições da aplicação (Fase 3, Task 2) — armazenamento chave/valor operacional
// das 4 secções de `Settings` (horário, mensagens de handoff, SLA, modo IA por defeito).
//
// GLOBAL por decisão (faseDataTask 2): é config operacional de produto, não dado de
// negócio de um tenant — pelo que NÃO recebe `tenant_id` (não entra no contrato
// spec §4.2 da Onda 1). Se no futuro alguma secção tiver de ser por tenant (ex.:
// horário distinto por empresa), é um ADR a separar em tabela com `tenant_id`.

import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { updatedAt } from '../knowledge/knowledge.schema.js';

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});
