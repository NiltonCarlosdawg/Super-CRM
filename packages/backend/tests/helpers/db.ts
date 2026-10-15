// Helpers de base de dados para os testes de integração (Fase 1, Task 1).
//
// Convenção: BD única por execução (`TEST_DATABASE_URL`, default = contentor de
// teste em :5433), isolamento entre ficheiros por `--test-concurrency=1`
// (scripts/integration-test.sh) + `resetDb()` (TRUNCATE CASCADE de todas as
// tabelas do CRM, exceto as do drizzle). `migrateFromEmptyDb` memoiza por
// processo; o `migrate` do drizzle é idempotente entre processos (journal).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDb, type DbClient } from '../../src/adapters/db/index.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://crm_test:crm_test@127.0.0.1:5433/crm_test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '../../drizzle');

export const LEAD_STAGE_VALUES = ['open', 'won', 'lost'] as const;

let pool: Pool | undefined;
let db: DbClient | undefined;
let migratePromise: Promise<void> | undefined;

function client(): DbClient {
  if (!db) {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL });
    db = createDb(pool);
  }
  return db;
}

// Fecha a ligação no fim de cada ficheiro de teste (sem isto o processo fica
// com o event loop ativo e não termina).
after(async () => {
  await pool?.end();
  pool = undefined;
  db = undefined;
});

/** Aplica `drizzle/` de 0000 → latest (memo por processo). */
export async function migrateFromEmptyDb(): Promise<void> {
  migratePromise ??= migrate(client(), { migrationsFolder: MIGRATIONS_FOLDER });
  return migratePromise;
}

/** TRUNCATE CASCADE de todas as tabelas do CRM, exceto as do drizzle. */
export async function resetDb(): Promise<void> {
  const res = await client().execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name <> '__drizzle_migrations'
  `);
  // Nomes vêm da própria BD; validados contra o vocabulário de identificadores
  // antes de entrar no SQL (nunca concatenar input — docs/02 §5).
  const names = (res.rows as Array<{ table_name: string }>)
    .map((r) => r.table_name)
    .filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
  if (names.length > 0) {
    await client().execute(sql.raw(`TRUNCATE TABLE ${names.map((n) => `"${n}"`).join(', ')} CASCADE`));
  }
}

/** migrateFromEmptyDb + resetDb + cliente (convenção da Fase 1). */
export async function migratedDb(): Promise<DbClient> {
  await migrateFromEmptyDb();
  await resetDb();
  return client();
}

/** Nomes de coluna de uma tabela, lidos de `information_schema.columns`. */
export async function columnNames(db: DbClient, table: string): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `);
  return (res.rows as Array<{ column_name: string }>).map((r) => r.column_name);
}
