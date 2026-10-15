// Fase 1, Task 7: login com Postgres real (sessões + users + audit), MfaPort
// fake (o TOTP real é a Task 8) e relógio controlado (docs/02 §3).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../../src/adapters/db/auth.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createLoginService } from '../../src/application/auth/login.js';
import { createLoginLimiter } from '../../src/application/auth/login-limiter.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import type { AuthConfig } from '../../src/infra/config-app.js';
import type { MfaPort } from '../../src/ports/auth.js';
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

const fakeMfa: MfaPort = {
  startSetup: async ({ email }) => ({
    otpauthUrl: `otpauth://totp/MilVendas:${email}?secret=JBSWY3DPEHPK3PXP&issuer=MilVendas`,
  }),
  verifyAndFinish: async () => true,
};

function makeService(db: Awaited<ReturnType<typeof migratedDb>>, clock: { t: number }) {
  const hasher = createArgon2Hasher();
  return createLoginService({
    users: createAuthUserRepo({ db, hasher }),
    sessions: createSessionStore({ db }),
    hasher,
    mfa: fakeMfa,
    limiter: createLoginLimiter(
      { max: cfg.loginRateMax, windowMs: cfg.loginRateWindowMs, lockMaxMs: cfg.loginLockMaxMs },
      () => new Date(clock.t),
    ),
    audit: createAuditAdapter({ db }),
    cfg,
    now: () => new Date(clock.t),
  });
}

const senhaForte = 'senha-muito-forte-123';

test('login: password errada 5× → rate_limited; certa → sessão criada e audit', async () => {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  const email = 'agent@test.local';
  await db.insert(users).values({
    name: 'Agente', email, passwordHash: await hasher.hash(senhaForte), role: 'agent', active: true,
  });

  const clock = { t: Date.parse('2026-10-07T10:00:00.000Z') };
  const svc = makeService(db, clock);
  const ip = '10.0.0.1';

  for (let i = 0; i < 5; i++) {
    assert.equal((await svc.login({ email, password: 'errada', ip })).status, 'invalid_credentials');
  }
  const rl = await svc.login({ email, password: 'errada', ip });
  assert.equal(rl.status, 'rate_limited');
  assert.equal((rl as { retryAfterSeconds: number }).retryAfterSeconds, 30);

  // o bloqueio também cobre a password certa — só passa quando expira
  clock.t += 31_000;
  const ok = await svc.login({ email, password: senhaForte, ip });
  assert.equal(ok.status, 'ok');
  const sessionId = (ok as { sessionId: string }).sessionId;
  assert.ok(await svc.loadSession(sessionId));

  // audit: 5 falhas (sem password no detalhe) + 1 sucesso
  const rows = await db.select().from(auditLog);
  assert.equal(rows.filter((a) => a.action === 'auth.login').length, 1);
  assert.equal(rows.filter((a) => a.action === 'auth.login_failed').length, 5);
  assert.ok(!JSON.stringify(rows).includes('errada'), 'password nunca aparece na auditoria');
});

test('login de admin sem TOTP → mfa_setup_required e sessão mfaPending', async () => {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  const email = 'admin@test.local';
  await db.insert(users).values({
    name: 'Admin', email, passwordHash: await hasher.hash(senhaForte), role: 'admin', active: true,
  });
  const clock = { t: Date.parse('2026-10-07T11:00:00.000Z') };
  const svc = makeService(db, clock);

  const r = await svc.login({ email, password: senhaForte, ip: '10.0.0.2' });
  assert.equal(r.status, 'mfa_setup_required');
  assert.match((r as { otpauthUrl: string }).otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await svc.loadSession((r as { sessionId: string }).sessionId))?.mfaPending, true);
});

test('utilizador inativo e password errada devolvem a MESMA resposta (anti-enumeração)', async () => {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  await db.insert(users).values({
    name: 'Inativo', email: 'inativo@test.local', passwordHash: await hasher.hash(senhaForte),
    role: 'agent', active: false,
  });
  const clock = { t: Date.parse('2026-10-07T12:00:00.000Z') };
  const svc = makeService(db, clock);

  assert.equal((await svc.login({ email: 'inexistente@test.local', password: 'x', ip: '10.0.0.3' })).status, 'invalid_credentials');
  assert.equal((await svc.login({ email: 'inativo@test.local', password: senhaForte, ip: '10.0.0.3' })).status, 'invalid_credentials');
});
