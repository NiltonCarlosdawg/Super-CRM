// Onda 1, Task 3 (spec multitenant §4.3): /me devolve `scope`; com o tenant
// suspenso na BD, QUALQUER pedido autenticado de um utilizador de tenant →
// 403 tenant_suspended. A plataforma (platform_admin, sem tenant) não é
// afectada — a suspensão é propriedade de um tenant, não da plataforma.

import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { MILVENDAS_TENANT_ID, tenants } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import { buildTestApp, TEST_PASSWORD } from '../helpers/http.js';

test('/me devolve scope; tenant suspenso → 403 tenant_suspended em qualquer pedido autenticado', async () => {
  const app = await buildTestApp();

  // login (agente) → /me inclui scope 'tenant'
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'agent@test.local', password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const agentSession = login.cookies.find((c) => c.name === 'session')?.value ?? '';
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: agentSession } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual({ role: me.json().role, scope: me.json().scope }, { role: 'agent', scope: 'tenant' });

  // platform_admin (linha criada directamente — CHECK exige tenant_id NULL)
  const hasher = createArgon2Hasher();
  const [platform] = await app.db
    .insert(users)
    .values({
      tenantId: null,
      name: 'Plataforma',
      email: 'platform@test.local',
      passwordHash: await hasher.hash(TEST_PASSWORD),
      role: 'platform_admin',
      active: true,
    })
    .returning({ id: users.id });
  assert.ok(platform !== undefined);
  const platformLogin = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'platform@test.local', password: TEST_PASSWORD },
  });
  assert.equal(platformLogin.statusCode, 200);
  const platformSession = platformLogin.cookies.find((c) => c.name === 'session')?.value ?? '';

  // suspender o tenant na BD
  await app.db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, MILVENDAS_TENANT_ID));

  // qualquer pedido autenticado de utilizadores do tenant → 403 tenant_suspended
  const tenantRequests = [
    { method: 'GET' as const, url: '/v1/auth/me', cookies: { session: agentSession } },
    { method: 'GET' as const, url: '/v1/auth/me', cookies: { session: app.sessions.admin } },
    { method: 'GET' as const, url: '/v1/users', cookies: { session: app.sessions.admin } },
    { method: 'GET' as const, url: '/v1/conversations', cookies: { session: app.sessions.agent } },
  ];
  for (const request of tenantRequests) {
    const res = await app.inject(request);
    assert.equal(res.statusCode, 403, `${request.method} ${request.url}`);
    assert.equal(res.json().title, 'tenant_suspended', `${request.method} ${request.url}`);
  }

  // a plataforma (sem tenant) continua a autenticar e vê scope 'platform'
  const platformMe = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    cookies: { session: platformSession },
  });
  assert.equal(platformMe.statusCode, 200);
  assert.deepEqual(
    { role: platformMe.json().role, scope: platformMe.json().scope },
    { role: 'platform_admin', scope: 'platform' },
  );
});
