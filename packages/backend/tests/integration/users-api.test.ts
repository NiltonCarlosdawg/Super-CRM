// Fase 1, Task 10: API de utilizadores com RBAC admin, normalização de email,
// guarda do último admin ativo e revogação de sessões em mudanças sensíveis.

import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { buildTestApp, TEST_PASSWORD } from '../helpers/http.js';

test('RBAC e guarda do último admin', async () => {
  const app = await buildTestApp();
  const post = (s: string, csrf: string, payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/users', cookies: { session: s, csrf }, headers: { 'x-csrf-token': csrf }, payload });

  assert.equal((await app.inject({ method: 'GET', url: '/v1/users' })).statusCode, 401);
  assert.equal((await post(app.sessions.agent, app.csrf.agent, {})).statusCode, 403);

  const created = await post(app.sessions.admin, app.csrf.admin,
    { name: 'Novo', email: 'NOVO@test.local', role: 'agent', password: TEST_PASSWORD });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().user.email, 'novo@test.local', 'email normalizado para minúsculas');

  const dup = await post(app.sessions.admin, app.csrf.admin,
    { name: 'Novo', email: 'novo@test.local', role: 'agent', password: TEST_PASSWORD });
  assert.equal(dup.statusCode, 409);

  // último admin: remover o papel ao próprio → 403
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/users/${app.users.admin.id}`,
    cookies: { session: app.sessions.admin, csrf: app.csrf.admin }, headers: { 'x-csrf-token': app.csrf.admin },
    payload: { role: 'agent' } })).statusCode, 403);

  // desativar UM admin havendo outro ativo é permitido (o 409 last_admin fica
  // para a defesa em profundidade: via API pública o ator admin conta sempre)
  const admin2 = await post(app.sessions.admin, app.csrf.admin,
    { name: 'Admin2', email: 'admin2@test.local', role: 'admin', password: TEST_PASSWORD });
  assert.equal(admin2.statusCode, 201);
  const deact = await app.inject({ method: 'PATCH', url: `/v1/users/${admin2.json().user.id}`,
    cookies: { session: app.sessions.admin, csrf: app.csrf.admin }, headers: { 'x-csrf-token': app.csrf.admin },
    payload: { active: false } });
  assert.equal(deact.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: '/v1/users', cookies: { session: app.sessions.admin } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().users.length, 5); // agent, editor, admin, novo, admin2
  await app.close();
});

test('reset de palavra-passe invalida as sessões do utilizador alvo', async () => {
  const app = await buildTestApp();
  const r = await app.inject({
    method: 'PATCH', url: `/v1/users/${app.users.agent.id}`,
    cookies: { session: app.sessions.admin, csrf: app.csrf.admin }, headers: { 'x-csrf-token': app.csrf.admin },
    payload: { password: 'nova-senha-forte-999' },
  });
  assert.equal(r.statusCode, 200);

  // a sessão antiga do alvo morreu
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: app.sessions.agent } })).statusCode, 401);
  // a password antiga deixa de entrar; a nova entra
  const old = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: app.users.agent.email, password: TEST_PASSWORD } });
  assert.equal(old.statusCode, 401);
  const fresh = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: app.users.agent.email, password: 'nova-senha-forte-999' } });
  assert.equal(fresh.statusCode, 200);

  const resets = await app.db.select().from(auditLog).where(eq(auditLog.action, 'user.password_reset'));
  assert.equal(resets.length, 1);
  assert.equal(resets[0]?.actorId, app.users.admin.id, 'reset atribuído ao admin que o fez');
  await app.close();
});
