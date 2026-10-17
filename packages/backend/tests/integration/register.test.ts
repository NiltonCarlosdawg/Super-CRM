// Onda 1, Task 6: POST /v1/auth/register com Postgres real — cria tenant+admin
// numa transacção (audit 'auth.register' incluído), devolve a MESMA resposta do
// login (mfa setup + cookies session/csrf) e faz ROLLBACK TOTAL quando o hasher
// falha a meio. Só o contentor de teste (:5433) — nunca o Postgres/Redis de
// desenvolvimento (scripts/integration-test.sh).

import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../../src/adapters/db/auth.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { tenants } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createLoginLimiter } from '../../src/application/auth/login-limiter.js';
import { createLoginService } from '../../src/application/auth/login.js';
import { createRegisterService } from '../../src/application/auth/register.js';
import type { AuthConfig } from '../../src/infra/config-app.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import type { MfaPort } from '../../src/ports/auth.js';
import type { PasswordHasher } from '../../src/ports/security.js';
import { migratedDb } from '../helpers/db.js';
import { buildTestApp, TEST_PASSWORD } from '../helpers/http.js';

test('POST /v1/auth/register → 200 mfa setup + cookies + tenant/admin/audit', async () => {
  const app = await buildTestApp();
  try {
    // Sem cookie de sessão e SEM header x-csrf-token: a rota é pública e isenta
    // (o guard global de CSRF só corre quando existe sessão — guards.ts).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        tenantName: 'Acme LDA',
        name: 'Fundador',
        email: 'Founder@Exemplo.COM',
        password: TEST_PASSWORD,
        role: 'platform_admin', // extra ao schema: o zod corta e o serviço fixa 'admin'
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { mfa: string; otpauthUrl: string; expiresAt: string };
    assert.equal(body.mfa, 'setup'); // igual ao login (auth.ts:69-71)
    assert.match(body.otpauthUrl, /^otpauth:\/\//);
    assert.ok(!Number.isNaN(Date.parse(body.expiresAt)));

    const session = res.cookies.find((c) => c.name === 'session');
    const csrf = res.cookies.find((c) => c.name === 'csrf');
    assert.ok(session?.httpOnly, 'cookie session HttpOnly');
    assert.equal(session?.sameSite, 'Lax');
    assert.ok(csrf !== undefined && csrf.httpOnly !== true, 'cookie csrf legível por JS');

    // linhas: tenant novo + admin NO tenant novo (email normalizado em lower)
    const db = app.db;
    const t = await db.select().from(tenants).where(eq(tenants.name, 'Acme LDA'));
    assert.equal(t.length, 1);
    const tenant = t[0]!;
    const u = await db.select().from(users).where(eq(users.email, 'founder@exemplo.com'));
    assert.equal(u.length, 1, 'email gravado em minúsculas');
    const user = u[0]!;
    assert.equal(user.role, 'admin'); // papel fixo, nunca do corpo
    assert.equal(user.tenantId, tenant.id);
    assert.equal(user.active, true);

    // audit 'auth.register' no tenant novo, actor = o admin criado
    const a = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.register'));
    assert.equal(a.length, 1);
    assert.equal(a[0]!.tenantId, tenant.id);
    assert.equal(a[0]!.actorId, user.id);

    // auto-login: a sessão devolvida é válida e está pendente de TOTP (como o login)
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      cookies: { session: session!.value },
    });
    assert.equal(me.statusCode, 403);
    assert.equal((me.json() as { title: string }).title, 'mfa_required');

    // email repetido (caixa diferente) → 409 e NENHUM tenant extra (rollback)
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        tenantName: 'Outra Empresa',
        name: 'Outro',
        email: 'FOUNDER@exemplo.com',
        password: TEST_PASSWORD,
      },
    });
    assert.equal(dup.statusCode, 409);
    assert.equal((dup.json() as { title: string }).title, 'email_already_exists');
    const t2 = await db.select().from(tenants);
    assert.equal(
      t2.filter((x) => x.name === 'Outra Empresa').length,
      0,
      'sem tenant órfão depois do 409',
    );
  } finally {
    await app.close();
  }
});

test('POST /v1/auth/register com password de 11 caracteres → 400 weak_password', async () => {
  const app = await buildTestApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        tenantName: 'Curta',
        name: 'Alguém',
        email: 'curta@exemplo.com',
        password: 'senha-12345', // 11 caracteres (política: 12–100, spec §5.1)
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { title: string }).title, 'weak_password');
    const t = await app.db.select().from(tenants).where(eq(tenants.name, 'Curta'));
    assert.equal(t.length, 0); // rejeitada antes de qualquer escrita
  } finally {
    await app.close();
  }
});

test('hasher que lança a meio → nenhuma linha nova (transacção)', async () => {
  const db = await migratedDb();
  const countAll = async () => ({
    tenants: (await db.select().from(tenants)).length,
    users: (await db.select().from(users)).length,
    audit: (await db.select().from(auditLog)).length,
  });
  const before = await countAll();

  // hasher avariado: lança DENTRO da transacção (depois do INSERT do tenant)
  const brokenHasher: PasswordHasher = {
    hash: async () => {
      throw new Error('hasher avariado (forçado no teste)');
    },
    verify: async () => false,
  };

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
  const fakeMfa: MfaPort = {
    startSetup: async ({ email }) => ({
      otpauthUrl: `otpauth://totp/MilVendas:${email}?secret=JBSWY3DPEHPK3PXP&issuer=MilVendas`,
    }),
    verifyAndFinish: async () => true,
  };
  const argon2 = createArgon2Hasher();
  const login = createLoginService({
    users: createAuthUserRepo({ db, hasher: argon2 }),
    sessions: createSessionStore({ db }),
    hasher: argon2,
    mfa: fakeMfa,
    limiter: createLoginLimiter(
      { max: cfg.loginRateMax, windowMs: cfg.loginRateWindowMs, lockMaxMs: cfg.loginLockMaxMs },
      () => new Date(),
    ),
    audit: createAuditAdapter({ db }),
    cfg,
    now: () => new Date(),
  });
  const svc = createRegisterService({
    db,
    hasher: brokenHasher,
    audit: createAuditAdapter({ db }),
    login,
    now: () => new Date(),
  });

  await assert.rejects(
    () =>
      svc.register({
        tenantName: 'Rolar Tudo',
        name: 'Alguém',
        email: 'rollback@exemplo.com',
        password: TEST_PASSWORD,
        ip: '10.0.0.9',
      }),
    (e: unknown) => e instanceof Error && e.message.includes('hasher avariado'),
  );

  assert.deepEqual(await countAll(), before, 'nenhuma linha nova após a falha a meio');
  const t = await db.select().from(tenants).where(eq(tenants.name, 'Rolar Tudo'));
  assert.equal(t.length, 0, 'o tenant da transacção falhada não existe');
});
