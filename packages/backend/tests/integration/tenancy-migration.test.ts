// Onda 1, Task 1: as migrações de multitenancy aplicam de uma base vazia e as
// constraints de `tenant_id` comportam-se como a spec exige — tabela `tenants`
// com o seed "MilVendas", NOT NULL nas tabelas de negócio, FK, anulabilidade
// só em audit_log/inbound_events, sessions/business_lines intocadas
// (docs/superpowers/specs/2026-10-16-multitenant-design.md §4).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/adapters/db/index.js';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { columnNames, migrateFromEmptyDb, migratedDb } from '../helpers/db.js';

/** Código SQLSTATE do erro do pg; o Drizzle embrulha o erro em `cause`. */
function sqlState(e: unknown): unknown {
  const code = (x: unknown): unknown =>
    typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined;
  return code(e) ?? code((e as { cause?: unknown }).cause);
}

/** As 23 tabelas de negócio com `tenant_id NOT NULL` (spec §4.2 — contrato
 *  completo). `users` sai daqui na Onda 1 Task 2: `tenant_id` passou a anulável
 *  para o platform_admin, com a invariante garantida pelo CHECK
 *  `users_platform_tenant_check` (ver NULLABLE_TENANT_TABLES e
 *  platform-admin.test.ts). */
const NOT_NULL_TENANT_TABLES = [
  'whatsapp_accounts', 'contacts', 'leads', 'conversations', 'messages',
  'outbox_messages', 'campaigns', 'campaign_recipients', 'campaign_accounts',
  'followup_sequences', 'followup_steps', 'followup_runs',
  'catalog_items', 'knowledge_docs', 'knowledge_chunks', 'rules',
  'qualification_questions', 'handoff_triggers', 'handoffs', 'knowledge_gaps',
  'knowledge_suggestions', 'knowledge_revisions', 'answer_traces',
] as const;

/** As 3 anuláveis (spec §4.2): audit_log/inbound_events = ação de plataforma /
 *  evento órfão; users = anulável SÓ para platform_admin (Onda 1 Task 2,
 *  invariante `(role = 'platform_admin') = (tenant_id IS NULL)` em CHECK). */
const NULLABLE_TENANT_TABLES = ['audit_log', 'inbound_events', 'users'] as const;

/** Tabelas de listagem com `(tenant_id)` + composto por data (spec §4.2).
 *  `inbound_events` não tem `created_at`: o composto é `(tenant_id, received_at)`. */
const LISTING_INDEX_TABLES = [
  'conversations', 'messages', 'contacts', 'leads', 'audit_log', 'outbox_messages', 'inbound_events',
] as const;

async function tenantIdNullable(db: DbClient, table: string): Promise<string | undefined> {
  const r = await db.execute(sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'tenant_id'`);
  return (r.rows as Array<{ is_nullable: string }>)[0]?.is_nullable;
}

test('migrações aplicam de zero e criam tenants + tenant_id obrigatório', async () => {
  await migrateFromEmptyDb();
  const db = await migratedDb();

  const tenantCols = (await columnNames(db, 'tenants')).sort();
  assert.deepEqual(tenantCols, ['created_at', 'id', 'name', 'status', 'updated_at']);

  const seed = await db.execute(
    sql`SELECT name, status FROM tenants WHERE id = ${MILVENDAS_TENANT_ID}::uuid`,
  );
  assert.deepEqual(seed.rows, [{ name: 'MilVendas', status: 'active' }]);

  const enumVals = await db.execute(sql`SELECT unnest(enum_range(NULL::tenant_status))::text AS v`);
  assert.deepEqual(
    (enumVals.rows as Array<{ v: string }>).map((r) => r.v),
    ['active', 'suspended'],
  );

  // Contrato das 23: tenant_id existe e é NOT NULL em todas.
  for (const table of NOT_NULL_TENANT_TABLES) {
    assert.equal(
      await tenantIdNullable(db, table),
      'NO',
      `${table}.tenant_id deve ser NOT NULL`,
    );
  }

  // Índices das tabelas de listagem: (tenant_id) + composto por data.
  for (const table of LISTING_INDEX_TABLES) {
    const compound = table === 'inbound_events' ? `${table}_tenant_received_idx` : `${table}_tenant_created_idx`;
    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${table}`);
    const names = (idx.rows as Array<{ indexname: string }>).map((r) => r.indexname);
    assert.ok(names.includes(`${table}_tenant_idx`), `índice (tenant_id) em ${table}`);
    assert.ok(names.includes(compound), `índice composto ${compound} em ${table}`);
  }
});

// Onda 1 Task 2: em users a falha passou a ser do CHECK (tenant_id anulável
// para platform_admin; papel de tenant sem tenant viola a invariante — 23514).
test('linhas novas sem tenant_id falham (CHECK em users, NOT NULL em conversations)', async () => {
  const db = await migratedDb();
  await assert.rejects(
    db.execute(
      sql`INSERT INTO users (name, email, password_hash, role)
          VALUES ('Sem Tenant', 'sem-tenant@test.local', 'hash', 'agent')`,
    ),
    (e: unknown) => sqlState(e) === '23514',
    'users (papel de tenant) sem tenant_id deve falhar com o CHECK (23514)',
  );
  await assert.rejects(
    db.execute(
      sql`INSERT INTO conversations (account_id, contact_id)
          VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid)`,
    ),
    (e: unknown) => sqlState(e) === '23502',
    'conversations sem tenant_id deve falhar com NOT NULL (23502)',
  );
});

test('FK: tenant_id inexistente falha', async () => {
  const db = await migratedDb();
  await assert.rejects(
    db.execute(
      sql`INSERT INTO users (name, email, password_hash, role, tenant_id)
          VALUES ('FK Test', 'fk@test.local', 'hash', 'agent', ${randomUUID()}::uuid)`,
    ),
    (e: unknown) => sqlState(e) === '23503',
    'tenant_id sem linha em tenants deve falhar com FK (23503)',
  );
});

test('audit_log e inbound_events aceitam tenant_id NULL', async () => {
  const db = await migratedDb();
  // Contrato das 2 anuláveis: tenant_id existe e é nullable (spec §4.2).
  for (const table of NULLABLE_TENANT_TABLES) {
    assert.equal(
      await tenantIdNullable(db, table),
      'YES',
      `${table}.tenant_id deve ser anulável`,
    );
  }
  await db.execute(sql`INSERT INTO audit_log (action, tenant_id) VALUES ('test.tenant_null', NULL)`);
  await db.execute(sql`
    INSERT INTO inbound_events (provider_event_id, payload, tenant_id)
    VALUES ('evt-tenant-null-test', '{}'::jsonb, NULL)`);
});

test('sessions e business_lines não têm coluna tenant_id', async () => {
  const db = await migratedDb();
  assert.equal((await columnNames(db, 'sessions')).includes('tenant_id'), false);
  assert.equal((await columnNames(db, 'business_lines')).includes('tenant_id'), false);
});
