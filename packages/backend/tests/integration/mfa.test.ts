// Fase 1, Task 8: MFA real sobre Postgres — segredo cifrado em BD,
// verifyAndFinish limpa mfaPending, marca totpEnabledAt e audita.

import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../../src/adapters/db/auth.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createMfaService } from '../../src/application/auth/mfa.js';
import { DomainError } from '../../src/domain/error.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import type { AuthConfig } from '../../src/infra/config-app.js';
import { createTotp, decryptSecret } from '../../src/infra/security/totp.js';
import { migratedDb } from '../helpers/db.js';

const cfg: AuthConfig = {
  authSecret: 'x'.repeat(32),
  sessionTtlHours: 72,
  loginRateMax: 5,
  loginRateWindowMs: 900_000,
  loginLockMaxMs: 3_600_000,
  totpIssuer: 'MilVendas',
  httpRateMax: 300,
  httpRateWindowMs: 60_000,
  bodyLimitBytes: 1_048_576,
};

test('mfa: segredo cifrado em BD; verify correto ativa, errado não; audit', async () => {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  const email = 'admin@test.local';
  const inserted = await db
    .insert(users)
    .values({
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin', email,
      passwordHash: await hasher.hash('senha-muito-forte-123'),
      role: 'admin', active: true,
    })
    .returning({ id: users.id });
  const userId = inserted[0]?.id;
  assert.ok(userId, 'utilizador criado');

  const clock = { t: Date.parse('2026-10-07T10:00:00.000Z') };
  const now = () => new Date(clock.t);
  const totp = createTotp();
  const sessions = createSessionStore({ db });
  const usersRepo = createAuthUserRepo({ db, hasher });
  const mfa = createMfaService({ users: usersRepo, sessions, totp, cfg, audit: createAuditAdapter({ db }), now });

  // sessão como o login a cria para admin sem TOTP (mfaPending)
  const { sessionId } = await sessions.create({
    userId, role: 'admin', mfaPending: true, now: now(), ttlHours: cfg.sessionTtlHours, ip: '10.0.0.1',
  });

  const { otpauthUrl } = await mfa.startSetup({ userId, email, now: now() });
  const secret = new URL(otpauthUrl).searchParams.get('secret');
  assert.ok(secret && secret.length === 32, 'segredo base32 de 32 chars');

  // BD guarda CIFRADO: o base32 nunca aparece em claro; a cifra decifra com o AUTH_SECRET
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  assert.ok(row?.totpSecret, 'totp_secret persistido');
  assert.ok(!row.totpSecret.includes(secret), 'segredo nunca em claro na BD');
  assert.equal(decryptSecret(row.totpSecret, cfg.authSecret), secret);

  // código errado → false, nada muda
  assert.equal(await mfa.verifyAndFinish({ sessionId, userId, code: '000000', now: now() }), false);
  assert.equal((await sessions.get(sessionId, now()))?.mfaPending, true);
  const [afterWrong] = await db.select().from(users).where(eq(users.id, userId));
  assert.equal(afterWrong?.totpEnabledAt, null);

  // código correto → ativa e limpa mfaPending
  const code = totp.generate(secret, now());
  assert.equal(await mfa.verifyAndFinish({ sessionId, userId, code, now: now() }), true);
  assert.equal((await sessions.get(sessionId, now()))?.mfaPending, false);
  const [afterOk] = await db.select().from(users).where(eq(users.id, userId));
  assert.ok(afterOk?.totpEnabledAt, 'totpEnabledAt marcado');

  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.totp_enabled'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.actorId, userId);
});

// Task 12 (ruling R29): depois de ACTIVO, um novo startSetup recusa (409 via
// fronteira) e o segredo em BD fica INTACTO — nunca rotação silenciosa.
test('mfa: startSetup com totp activo recusa e não rotaciona o segredo', async () => {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  const email = 'activa@test.local';
  const inserted = await db
    .insert(users)
    .values({
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Activa', email,
      passwordHash: await hasher.hash('senha-muito-forte-123'),
      role: 'admin', active: true,
    })
    .returning({ id: users.id });
  const userId = inserted[0]?.id;
  assert.ok(userId, 'utilizador criado');

  const now = () => new Date('2026-10-17T10:00:00.000Z');
  const totp = createTotp();
  const sessions = createSessionStore({ db });
  const usersRepo = createAuthUserRepo({ db, hasher });
  const mfa = createMfaService({ users: usersRepo, sessions, totp, cfg, audit: createAuditAdapter({ db }), now });

  // ciclo completo: setup + verify → TOTP activo
  const { otpauthUrl } = await mfa.startSetup({ userId, email, now: now() });
  const secret = new URL(otpauthUrl).searchParams.get('secret');
  assert.ok(secret, 'segredo do 1º setup');
  const { sessionId } = await sessions.create({
    userId, role: 'admin', mfaPending: true, now: now(), ttlHours: cfg.sessionTtlHours, ip: '10.0.0.2',
  });
  assert.equal(
    await mfa.verifyAndFinish({ sessionId, userId, code: totp.generate(secret, now()), now: now() }),
    true,
  );

  // TOTP activo: startSetup novo → DomainError totp_already_enabled (409 na fronteira)
  await assert.rejects(
    () => mfa.startSetup({ userId, email, now: now() }),
    (e: unknown) => e instanceof DomainError && e.code === 'totp_already_enabled',
  );

  // o segredo em BD é o do 1º setup — intocado
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  assert.equal(decryptSecret(row!.totpSecret!, cfg.authSecret), secret);
  assert.ok(row?.totpEnabledAt, 'totp continua activo');
});
