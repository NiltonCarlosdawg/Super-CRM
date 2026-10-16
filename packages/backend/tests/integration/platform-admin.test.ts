// Onda 1, Task 2: o papel platform_admin — enum + CHECK de isolamento + CLI de
// bootstrap (spec docs/superpowers/specs/2026-10-16-multitenant-design.md §4.3).
// Invariante: platform_admin ⇔ tenant_id NULL; todos os outros papéis ⇔
// tenant_id obrigatório (MilVendas por default no CLI).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import test from 'node:test';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { migrateFromEmptyDb, migratedDb } from '../helpers/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = path.resolve(HERE, '../../drizzle/meta/_journal.json');

// Env do script (mesmo padrão de create-user-script.test.ts): DATABASE_URL do
// contentor de teste, nunca a BD de desenvolvimento.
const testEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://crm_test:crm_test@127.0.0.1:5433/crm_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUTH_SECRET: 'x'.repeat(32),
  AUTH_TOTP_ISSUER: 'MilVendas',
  WA_AKG_BASE_URL: 'http://wa.local:3001',
  WA_AKG_API_KEY: 'chave-teste',
  WA_WEBHOOK_SECRET: 's'.repeat(32),
};

function runScript(args: string[], input: string) {
  return spawnSync('npx', ['--no-install', 'tsx', 'scripts/create-user.ts', ...args], {
    input,
    env: testEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Código SQLSTATE do erro do pg; o Drizzle embrulha o erro em `cause`. */
function sqlState(e: unknown): unknown {
  const code = (x: unknown): unknown =>
    typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined;
  return code(e) ?? code((e as { cause?: unknown }).cause);
}

test('migrações aplicam de zero (enum separado — sem unsafe use of new value)', async () => {
  // O `migrateFromEmptyDb()` acima falharia com "unsafe use of new value" se o
  // ADD VALUE do enum e o CHECK que usa 'platform_admin' caíssem na mesma
  // transação (o migrator do Drizzle aplica tudo numa só — por isso a migração
  // do enum fecha a transação antes de o CHECK correr).
  await migrateFromEmptyDb();
  const db = await migratedDb();

  // enum user_role com platform_admin como último valor (ADD VALUE sem BEFORE/AFTER)
  const vals = await db.execute(sql`SELECT unnest(enum_range(NULL::user_role))::text AS v`);
  assert.deepEqual(
    (vals.rows as Array<{ v: string }>).map((r) => r.v),
    ['admin', 'editor', 'agent', 'platform_admin'],
  );

  // tenant_id de users passou a anulável (NULL = platform admin)
  const col = await db.execute(sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'tenant_id'`);
  assert.equal((col.rows as Array<{ is_nullable: string }>)[0]?.is_nullable, 'YES');

  // CHECK presente, com o nome e a forma do contrato
  const con = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'users_platform_tenant_check' AND conrelid = 'users'::regclass`);
  assert.equal(con.rows.length, 1, 'users_platform_tenant_check existe');
  const def = (con.rows[0] as { def: string }).def;
  assert.match(def, /'platform_admin'/, 'a comparação usa o valor do enum');
  assert.match(def, /tenant_id IS NULL/, 'liga role platform_admin a tenant_id NULL');

  // split registado no journal: enum (0005) e CHECK (0006) em entradas separadas
  interface JournalEntry { idx: number; tag: string; when: number }
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] };
  const tags = journal.entries.map((e) => e.tag);
  const i5 = tags.findIndex((t) => t.startsWith('0005_'));
  const i6 = tags.findIndex((t) => t.startsWith('0006_'));
  assert.notEqual(i5, -1, 'entrada 0005_* (enum) no journal');
  assert.notEqual(i6, -1, 'entrada 0006_* (CHECK) no journal');
  assert.equal(i6, i5 + 1, 'entradas consecutivas');
  assert.ok(
    journal.entries[i5]!.when < journal.entries[i6]!.when,
    'when estritamente crescente (senão o migrator salta a 0006)',
  );
});

test('INSERT platform_admin COM tenant_id viola o CHECK (e admin sem tenant também)', async () => {
  const db = await migratedDb();

  // estado pré-existente conforme: platform_admin sem tenant + papéis de tenant com MilVendas
  await db.execute(sql`
    INSERT INTO users (name, email, password_hash, role, tenant_id)
    VALUES ('Plat', 'plat-check@test.local', 'hash', 'platform_admin', NULL)`);
  await db.execute(sql`
    INSERT INTO users (name, email, password_hash, role, tenant_id)
    VALUES ('Admin', 'admin-check@test.local', 'hash', 'admin', ${MILVENDAS_TENANT_ID}::uuid)`);

  // violações da invariante → 23514
  await assert.rejects(
    db.execute(sql`
      INSERT INTO users (name, email, password_hash, role, tenant_id)
      VALUES ('X', 'plat-com-tenant@test.local', 'hash', 'platform_admin', ${MILVENDAS_TENANT_ID}::uuid)`),
    (e: unknown) => sqlState(e) === '23514',
    'platform_admin COM tenant_id deve violar o CHECK (23514)',
  );
  await assert.rejects(
    db.execute(sql`
      INSERT INTO users (name, email, password_hash, role, tenant_id)
      VALUES ('Y', 'admin-sem-tenant@test.local', 'hash', 'admin', NULL)`),
    (e: unknown) => sqlState(e) === '23514',
    'admin sem tenant_id deve violar o CHECK (23514)',
  );

  // estado existente: re-adicionar o CHECK valida as linhas já na tabela — se
  // alguma violasse a invariante, o ADD CONSTRAINT falhava (como no upgrade real)
  await db.execute(sql`ALTER TABLE users DROP CONSTRAINT users_platform_tenant_check`);
  await db.execute(sql`
    ALTER TABLE users ADD CONSTRAINT users_platform_tenant_check
    CHECK ((role = 'platform_admin') = (tenant_id IS NULL))`);
});

test('criar platform admin via CLI deixa tenant_id NULL', async () => {
  const db = await migratedDb();

  const r = runScript(
    ['--email', 'platform@test.local', '--name', 'Plataforma', '--role', 'platform_admin'],
    'senha-muito-forte-123',
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /created user platform@test\.local role platform_admin/);

  const rows = await db.select().from(users).where(eq(users.email, 'platform@test.local'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, 'platform_admin');
  assert.equal(rows[0]?.tenantId, null, 'platform admin não pertence a nenhum tenant');

  // --tenant com --role platform_admin é rejeitado (a plataforma não tem tenant)
  const r2 = runScript(
    [
      '--email', 'platform-com-tenant@test.local', '--name', 'P2',
      '--role', 'platform_admin', '--tenant', MILVENDAS_TENANT_ID,
    ],
    'senha-muito-forte-123',
  );
  assert.equal(r2.status, 1, 'platform_admin com --tenant deve falhar');
});

test('criar admin de tenant sem --tenant usa o tenant MilVendas (default)', async () => {
  const db = await migratedDb();

  const r = runScript(
    ['--email', 'admin-tenant@test.local', '--name', 'Admin T', '--role', 'admin'],
    'senha-muito-forte-123',
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const rows = await db.select().from(users).where(eq(users.email, 'admin-tenant@test.local'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, 'admin');
  assert.equal(rows[0]?.tenantId, MILVENDAS_TENANT_ID, 'default = tenant MilVendas');

  // --tenant explícito é honrado (tenant existente)
  const outroTenant = randomUUID();
  await db.execute(sql`
    INSERT INTO tenants (id, name, status) VALUES (${outroTenant}::uuid, 'Outro Tenant', 'active')`);
  const r2 = runScript(
    [
      '--email', 'admin-outro@test.local', '--name', 'Admin O',
      '--role', 'editor', '--tenant', outroTenant,
    ],
    'senha-muito-forte-123',
  );
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
  const rows2 = await db.select().from(users).where(eq(users.email, 'admin-outro@test.local'));
  assert.equal(rows2[0]?.tenantId, outroTenant);

  // --tenant com formato inválido é rejeitado antes de tocar na BD
  const r3 = runScript(
    ['--email', 'admin-tt@test.local', '--name', 'TT', '--role', 'agent', '--tenant', 'nao-e-uuid'],
    'senha-muito-forte-123',
  );
  assert.equal(r3.status, 1, '--tenant não-uuid deve falhar');
});
