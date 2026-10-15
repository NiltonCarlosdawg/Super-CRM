// Fase 1, Task 9: rotas de auth — login/logout/me/password/totp sobre o
// buildTestApp (cookies reais, MfaPort fake com código fixo '123456').
//
// Nota: o 3.º teste do plano (agent em POST /v1/users → 403) foi adiado para
// a Task 10 — /v1/users ainda não existe aqui (daria 404); a Task 10 cobre a
// mesma asserção em users-api.test.ts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../helpers/http.js';

test('login/logout e guards', async () => {
  const app = await buildTestApp();
  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

  const bad = await login('agent@test.local', 'errada');
  assert.equal(bad.statusCode, 401);
  assert.ok(bad.headers['content-type']?.startsWith('application/problem+json'));
  assert.equal(bad.json().title, 'invalid_credentials');
  for (let i = 0; i < 4; i++) assert.equal((await login('agent@test.local', 'errada')).statusCode, 401);

  const good = await login('agent@test.local', 'senha-muito-forte-123');
  assert.equal(good.statusCode, 200);
  const sessionCookie = good.cookies.find((c) => c.name === 'session');
  assert.ok(sessionCookie?.httpOnly && sessionCookie?.sameSite === 'Lax');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: sessionCookie?.value ?? '' } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, 'agent');

  // CSRF: sessão válida sem header → 403
  const noCsrf = await app.inject({
    method: 'POST', url: '/v1/auth/password', cookies: { session: app.sessions.admin },
    payload: { currentPassword: 'senha-muito-forte-123', newPassword: 'outra-senha-forte-1' },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.ok(noCsrf.json().detail?.match(/csrf/i));
  // sem sessão → 401
  const noSess = await app.inject({
    method: 'POST', url: '/v1/auth/password',
    payload: { currentPassword: 'senha-muito-forte-123', newPassword: 'outra-senha-forte-1' },
  });
  assert.equal(noSess.statusCode, 401);

  // logout revoga a sessão
  const out = await app.inject({
    method: 'POST', url: '/v1/auth/logout',
    cookies: { session: app.sessions.agent, csrf: app.csrf.agent },
    headers: { 'x-csrf-token': app.csrf.agent },
  });
  assert.equal(out.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: app.sessions.agent } })).statusCode, 401);
});

test('admin pendente de TOTP: /v1/auth/me → 403 mfa_required; totp/verify → 200', async () => {
  const app = await buildTestApp();
  const login = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    payload: { email: app.users.admin.email, password: 'senha-muito-forte-123' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfa, 'setup');
  const pending = login.cookies.find((c) => c.name === 'session')?.value ?? '';
  assert.equal(
    (await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: pending } })).statusCode,
    403,
  );
  const csrf = login.cookies.find((c) => c.name === 'csrf')?.value ?? '';
  const ok = await app.inject({
    method: 'POST', url: '/v1/auth/totp/verify',
    cookies: { session: pending, csrf },
    headers: { 'x-csrf-token': csrf },
    payload: { code: '123456' }, // código fixo do MfaPort fake do buildTestApp
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: pending } })).statusCode,
    200,
  );
});
