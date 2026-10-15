// Cliente Drizzle da base — único ponto de criação da ligação (docs/02 §1:
// Drizzle vive em adapters). `DbClient` é o tipo consumido por repositórios,
// application e pelos helpers de teste (docs/plans/...fase1, Task 1).

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as knowledgeSchema from '../../modules/knowledge/knowledge.schema.js';
import * as baseSchema from './schema/index.js';

/** Fábrica do cliente: só recebe um Pool já configurado (config validada no arranque). */
export function createDb(pool: Pool) {
  // knowledge incluído porque `searchChunks`/`seedHandoffTriggers` consultam as
  // 12 tabelas do módulo através do mesmo cliente.
  return drizzle(pool, { schema: { ...baseSchema, ...knowledgeSchema } });
}

export type DbClient = ReturnType<typeof createDb>;
