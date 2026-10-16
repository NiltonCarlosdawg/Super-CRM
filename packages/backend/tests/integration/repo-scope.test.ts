// Onda 1, Task 4: escopo de tenant nos repositórios HTTP, nas rotas e no
// handshake realtime (spec multitenant §4.3; rulings R1/R9/R14). Cross-tenant
// = null/404, NUNCA 403 (esconder a existência). Fixtures sintéticas — as 20
// conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createConversationsRepository } from '../../src/adapters/db/conversations.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { tenants } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createUsersRepository } from '../../src/adapters/db/users.js';
import { createSocketNotify } from '../../src/adapters/realtime/socket.js';
import type { TenantScope } from '../../src/ports/tenancy.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

const scopeA: TenantScope = { tenantId: base.MILVENDAS_TENANT_ID };

/** Tenant B + user admin, conta WhatsApp, contacto e conversa sintéticos. */
async function seedTenantB(app: TestApp): Promise<{
  scopeB: TenantScope;
  userB: { id: string; name: string };
  accountB: { id: string };
  conversationB: { id: string };
}> {
  const [tenantB] = await app.db
    .insert(tenants)
    .values({ id: randomUUID(), name: 'Empresa B (sintética)' })
    .returning({ id: tenants.id });
  if (tenantB === undefined) throw new Error('falhou criar tenant B');
  const scopeB: TenantScope = { tenantId: tenantB.id };

  const [userB] = await app.db
    .insert(users)
    .values({
      tenantId: tenantB.id,
      name: 'Admin B',
      email: 'admin-b@empresa-b.test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'admin',
      active: true,
    })
    .returning({ id: users.id, name: users.name });
  if (userB === undefined) throw new Error('falhou criar user B');

  const [accountB] = await app.db
    .insert(base.whatsappAccounts)
    .values({
      tenantId: tenantB.id,
      label: 'Conta B',
      providerSessionId: 'sess-repo-scope-b',
      purpose: 'support',
    })
    .returning({ id: base.whatsappAccounts.id });
  if (accountB === undefined) throw new Error('falhou criar conta B');

  const [contactB] = await app.db
    .insert(base.contacts)
    .values({ tenantId: tenantB.id, phoneE164: '+244923000001', name: 'Cliente B' })
    .returning({ id: base.contacts.id });
  if (contactB === undefined) throw new Error('falhou criar contacto B');

  const [conversationB] = await app.db
    .insert(base.conversations)
    .values({ tenantId: tenantB.id, accountId: accountB.id, contactId: contactB.id })
    .returning({ id: base.conversations.id });
  if (conversationB === undefined) throw new Error('falhou criar conversa B');

  return { scopeB, userB, accountB, conversationB };
}

test('accounts.get(scopeA, contaDeB) → null', async () => {
  const app = await buildTestApp();
  try {
    const { scopeB, accountB } = await seedTenantB(app);
    const accounts = createAccountsRepository({ db: app.db });

    assert.equal(
      await accounts.get(scopeA, accountB.id),
      null,
      'conta alheia não é visível pelo escopo A (cross-tenant = null, nunca 403)',
    );
    // O próprio escopo continua a vê-la (o filtro é por tenant, não por id).
    assert.equal((await accounts.get(scopeB, accountB.id))?.id, accountB.id);
  } finally {
    await app.close();
  }
});

test('conversations.list(scopeA) não devolve conversas de B', async () => {
  const app = await buildTestApp();
  try {
    const { scopeB, conversationB } = await seedTenantB(app);
    const repo = createConversationsRepository(app.db);

    const pageA = await repo.list(scopeA, { limit: 50 });
    assert.ok(
      pageA.items.every((c) => c.id !== conversationB.id),
      'listagem de A não inclui conversas de B',
    );
    const pageB = await repo.list(scopeB, { limit: 50 });
    assert.ok(
      pageB.items.some((c) => c.id === conversationB.id),
      'o escopo B continua a ver a sua conversa',
    );
  } finally {
    await app.close();
  }
});

test('users.list(scopeA) não devolve users de B', async () => {
  const app = await buildTestApp();
  try {
    const { scopeB, userB } = await seedTenantB(app);
    const repo = createUsersRepository({ db: app.db });

    const listA = await repo.list(scopeA);
    assert.ok(listA.every((u) => u.id !== userB.id), 'listagem de A não inclui users de B');
    assert.equal(
      await repo.findById(scopeA, userB.id),
      null,
      'get de utilizador alheio → null (esconde a existência)',
    );
    const listB = await repo.list(scopeB);
    assert.ok(listB.some((u) => u.id === userB.id), 'o escopo B continua a ver o seu user');
  } finally {
    await app.close();
  }
});

test('PATCH /v1/users/:idDeB com sessão de A → 404', async () => {
  const app = await buildTestApp();
  try {
    const { userB } = await seedTenantB(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${userB.id}`,
      cookies: { session: app.sessions.admin, csrf: app.csrf.admin },
      headers: { 'x-csrf-token': app.csrf.admin },
      payload: { name: 'Name Hackeado' },
    });
    assert.equal(res.statusCode, 404, 'cross-tenant = 404, nunca 403 (esconde a existência)');
    const [row] = await app.db.select().from(users).where(eq(users.id, userB.id));
    assert.equal(row?.name, 'Admin B', 'a linha alheia ficou intacta');
  } finally {
    await app.close();
  }
});

test('GET /v1/conversations/:idDeB com sessão de A → 404', async () => {
  const app = await buildTestApp();
  try {
    const { conversationB } = await seedTenantB(app);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationB.id}`,
      cookies: { session: app.sessions.agent },
    });
    assert.equal(res.statusCode, 404, 'cross-tenant = 404, nunca 403');
  } finally {
    await app.close();
  }
});

// ── Handshake realtime (R14, amendado para a Task 4) ──

const clients: Socket[] = [];

/** Handshake com cookie session= (o middleware lê handshake.headers.cookie). */
function connectClientRaw(app: TestApp, sessionId: string): Promise<Socket> {
  const address = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const client = connect(`http://127.0.0.1:${address.port}`, {
      extraHeaders: { cookie: `session=${sessionId}` },
      reconnection: false,
    });
    client.once('connect', () => resolve(client));
    client.once('connect_error', (err: Error) => {
      client.close();
      reject(err);
    });
  });
}

/** Resolve com o 1º payload do evento ou null ao expirar (prova o NÃO chegar). */
function collect(client: Socket, event: string, ms = 500): Promise<unknown> {
  return new Promise((resolve) => {
    const onEvent = (payload: unknown): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      client.off(event, onEvent);
      resolve(null);
    }, ms);
    client.once(event, onEvent);
  });
}

test('handshake realtime com user despromovido não recebe papel antigo (papel vem da linha users)', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    // Despromo directamente na BD (sem tocar nas sessões): a sessão continua
    // viva com o snapshot antigo — o handshake tem de Ler a linha `users`.
    await app.db
      .update(users)
      .set({ role: 'agent' })
      .where(eq(users.id, app.users.admin.id));

    const client = await connectClientRaw(app, app.sessions.admin);
    clients.push(client);

    const gotMessage = collect(client, 'message.created');
    const gotAccount = collect(client, 'account.status'); // sala admin: NÃO deve chegar
    const notify = createSocketNotify(app.realtime.io);
    await notify({ type: 'message', phase: 'created', messageId: 'm1', conversationId: 'c1' });
    await notify({ type: 'account', accountId: 'a1', status: 'connected' });

    assert.deepEqual(await gotMessage, { v: 1, messageId: 'm1', conversationId: 'c1' }, 'sala agent (papel actual)');
    assert.equal(await gotAccount, null, 'sem sala admin: o papel antigo da sessão não autoriza');
  } finally {
    for (const c of clients.splice(0)) c.close();
    await app.close();
  }
});

test('handshake realtime de tenant suspenso → rejeitado', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await app.db
      .update(tenants)
      .set({ status: 'suspended' })
      .where(eq(tenants.id, base.MILVENDAS_TENANT_ID));

    await assert.rejects(
      () => connectClientRaw(app, app.sessions.agent),
      /tenant_suspended/,
      'tenant suspenso não liga ao realtime (spec §4.3)',
    );
  } finally {
    for (const c of clients.splice(0)) c.close();
    await app.close();
  }
});
