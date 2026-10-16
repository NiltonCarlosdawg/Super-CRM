// Onda 1, Task 1: as migrações de multitenancy aplicam de uma base vazia e as
// constraints de `tenant_id` comportam-se como a spec exige — tabela `tenants`
// com o seed "MilVendas", NOT NULL nas tabelas de negócio, FK, anulabilidade
// só em audit_log/inbound_events, sessions/business_lines intocadas
// (docs/superpowers/specs/2026-10-16-multitenant-design.md §4).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { columnNames, migrateFromEmptyDb, migratedDb } from '../helpers/db.js';

/** Código SQLSTATE do erro do pg; o Drizzle embrulha o erro em `cause`. */
function sqlState(e: unknown): unknown {
  const code = (x: unknown): unknown =>
    typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined;
  return code(e) ?? code((e as { cause?: unknown }).cause);
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

  for (const table of ['users', 'conversations']) {
    const r = await db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'tenant_id'`);
    assert.equal(
      (r.rows as Array<{ is_nullable: string }>)[0]?.is_nullable,
      'NO',
      `${table}.tenant_id deve ser NOT NULL`,
    );
  }

  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'conversations'`);
  const names = (idx.rows as Array<{ indexname: string }>).map((r) => r.indexname);
  assert.ok(names.includes('conversations_tenant_idx'), 'índice (tenant_id) em conversations');
  assert.ok(
    names.includes('conversations_tenant_created_idx'),
    'índice composto (tenant_id, created_at) em conversations',
  );
});

test('linhas novas sem tenant_id falham (NOT NULL) em users e conversations', async () => {
  const db = await migratedDb();
  await assert.rejects(
    db.execute(
      sql`INSERT INTO users (name, email, password_hash, role)
          VALUES ('Sem Tenant', 'sem-tenant@test.local', 'hash', 'agent')`,
    ),
    (e: unknown) => sqlState(e) === '23502',
    'users sem tenant_id deve falhar com NOT NULL (23502)',
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
