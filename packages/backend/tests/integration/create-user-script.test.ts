// Fase 1, Task 6: o script de bootstrap cria o utilizador com hash argon2id,
// lê a palavra-passe por stdin (nunca argv/env), audita e é idempotente por email.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { migratedDb } from '../helpers/db.js';

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

test('create-user: cria admin com audit, duplicado falha, sem stdin falha', async () => {
  // migratedDb() também faz resetDb() — capturar ANTES de o script escrever.
  const db = await migratedDb();

  const r1 = runScript(
    ['--email', 'bootstrap@test.local', '--name', 'Bootstrap', '--role', 'admin'],
    'senha-muito-forte-123',
  );
  assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
  assert.match(r1.stdout, /created user bootstrap@test\.local role admin/);
  assert.ok(!r1.stdout.includes('senha-muito-forte-123'), 'palavra-passe nunca sai em stdout');

  // efeito na BD: utilizador ativo com hash argon2id + registo de auditoria
  const rows = await db.select().from(users).where(eq(users.email, 'bootstrap@test.local'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.role, 'admin');
  assert.ok(rows[0]?.active === true);
  assert.ok(rows[0]?.passwordHash.startsWith('$argon2id$'));
  const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'user.created'));
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]?.actorId, null, 'criação de bootstrap = ação de sistema');

  // segunda execução: mesmo email → falha limpa, sem duplicar
  const r2 = runScript(
    ['--email', 'bootstrap@test.local', '--name', 'Bootstrap', '--role', 'admin'],
    'senha-muito-forte-123',
  );
  assert.equal(r2.status, 1);
  assert.ok(`${r2.stderr}${r2.stdout}`.includes('email already exists'));

  // sem stdin → erro claro, nunca argv/env
  const r3 = runScript(
    ['--email', 'outro@test.local', '--name', 'Outro', '--role', 'agent'],
    '',
  );
  assert.equal(r3.status, 1);
  assert.ok(`${r3.stderr}${r3.stdout}`.includes('password via stdin'));
});
