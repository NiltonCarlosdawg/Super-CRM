// Onda 1, Task 8 (spec multitenant §8.2 — critério de aceitação da onda):
// suite de isolamento cross-tenant. Dois tenants A/B com dados espelhados por
// INSERTS DIRECTOS (users admin+agent, contas, contactos, leads, conversas,
// mensagens, campanhas, outbox) e a MATRIZ completa dirigida pelo INVENTÁRIO
// REAL de rotas (grep `app.(get|post|patch)`):
//
//   1. fixtures espelhados: mesmo formato de linhas por tenant;
//   2. leitura E mutação por id alheio → 404 (6 rotas com :id, nos dois sentidos);
//   3. listagens (users, contas, conversas) nunca contêm linhas do outro tenant;
//   4. rota de plataforma com sessão de tenant → 403 (7 rotas);
//   5. rota de tenant com sessão platform → 403 (11 rotas — matriz da T7);
//   6. qualquer rota com sessão mfaPending → 403 mfa_required, FORA da
//      MFA_ALLOWLIST (POST totp/setup, POST totp/verify, POST logout);
//   7. tenant suspenso → 403 tenant_suspended (spec §8.2);
//   8. drill de plataforma com :id fora do tenant perfurado → 404.
//
// Inventário real: 11 rotas de tenant (3 users + 4 whatsapp-accounts +
// 4 conversations) + 7 de plataforma. NÃO existem rotas de
// campaign/contact/lead/outbox no backend (famílias mencionadas no plano sem
// rota — a matriz cobre as rotas REAIS; campanhas/outbox entram só nos
// fixtures espelhados). Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { InjectOptions } from 'fastify';
import { createSessionStore } from '../../src/adapters/db/auth.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import * as base from '../../src/adapters/db/schema/index.js';
import type { Role } from '../../src/ports/auth.js';
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/http.js';

const PHONE_A = '+2449235551001';
const PHONE_B = '+2449235551002';

/** Sessão de teste: cookie de sessão + par csrf (cookie igual ao header). */
interface Sess {
  session: string;
  csrf: string;
}

/** Um lado do espelho: ids do tenant e dos seus dados de negócio. */
interface Side {
  tenantId: string;
  adminId: string;
  accountId: string;
  contactId: string;
  leadId: string;
  conversationId: string;
}

interface Fixture {
  tenantB: string;
  a: Side;
  b: Side;
  sessions: { aAdmin: Sess; bAdmin: Sess; platform: Sess };
  platformUserId: string;
  /** Sessões novas directas (SessionStore) — usadas para mfaPending. */
  mkSess: (userId: string, role: Role, mfaPending?: boolean) => Promise<Sess>;
}

type Method = 'GET' | 'POST' | 'PATCH';

interface RouteSpec {
  method: Method;
  url: string;
  /** Tipo EXACTO do `payload` de `inject` (fastify) — `unknown` derruba o
   *  overload de `inject` e torna todas as respostas `void` sob strict tsc. */
  payload?: InjectOptions['payload'];
  idempotencyKey?: string;
}

/** Tabela com coluna `tenant_id`: as tabelas concretas do drizzle são subtipos
 *  de `AnyPgTable`/`AnyPgColumn` (typecheck strict do ficheiro — R26: o
 *  tsconfig do projecto continua a incluir só `src/`). */
type TenantTable = AnyPgTable & { tenantId: AnyPgColumn };

/** Contagem de linhas de negócio por tenant (espelho directo A/B). */
async function rowCounts(db: DbClient, tenantId: string) {
  const count = async (table: TenantTable): Promise<number> =>
    (await db.select({ id: table.tenantId }).from(table).where(eq(table.tenantId, tenantId))).length;
  return {
    accounts: await count(base.whatsappAccounts),
    contacts: await count(base.contacts),
    leads: await count(base.leads),
    conversations: await count(base.conversations),
    messages: await count(base.messages),
    outbox: await count(base.outboxMessages),
    campaigns: await count(base.campaigns),
  };
}

/** Um lado do espelho, todo por inserts directos (o formato é idêntico). */
async function seedSide(
  app: TestApp,
  input: { tenantId: string; adminId: string; tag: string; phone: string },
): Promise<Side> {
  const { tenantId, adminId, tag, phone } = input;
  const [account] = await app.db
    .insert(base.whatsappAccounts)
    .values({ tenantId, label: `Iso ${tag}`, providerSessionId: `sess-iso-${tag}`, purpose: 'support' })
    .returning({ id: base.whatsappAccounts.id });
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId, phoneE164: phone, name: `Cliente ${tag}` })
    .returning({ id: base.contacts.id });
  const [lead] = await app.db
    .insert(base.leads)
    .values({ tenantId, contactId: contact!.id, stage: 'open', qualification: {} })
    .returning({ id: base.leads.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId, accountId: account!.id, contactId: contact!.id, leadId: lead!.id })
    .returning({ id: base.conversations.id });
  await app.db.insert(base.messages).values({
    tenantId,
    conversationId: conv!.id,
    accountId: account!.id,
    direction: 'inbound',
    sender: 'customer',
    body: `olá ${tag}`,
    status: 'sent',
  });
  const [out] = await app.db
    .insert(base.messages)
    .values({
      tenantId,
      conversationId: conv!.id,
      accountId: account!.id,
      direction: 'outbound',
      sender: 'human',
      body: `resp ${tag}`,
      status: 'sent',
    })
    .returning({ id: base.messages.id });
  // MESMA idempotency_key nos dois tenants: o unique composto (T5) deixa coexistir.
  await app.db.insert(base.outboxMessages).values({
    tenantId,
    messageId: out!.id,
    accountId: account!.id,
    idempotencyKey: 'iso-mirror',
  });
  await app.db.insert(base.campaigns).values({
    tenantId,
    name: `Campanha ${tag}`,
    messageTemplate: 'Olá {{nome}}',
    createdBy: adminId,
  });
  return {
    tenantId,
    adminId,
    accountId: account!.id,
    contactId: contact!.id,
    leadId: lead!.id,
    conversationId: conv!.id,
  };
}

/** Tenant B + users admin/agent, dados espelhados de A e B, sessões directas. */
async function seedMirror(app: TestApp): Promise<Fixture> {
  const [tenantB] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (isolation sintética)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenantB !== undefined, 'fixture tenant B');
  const [bAdmin] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenantB.id,
      name: 'Admin B',
      email: 'admin-b@iso.test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'admin',
      active: true,
    })
    .returning({ id: base.users.id });
  const [bAgent] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenantB.id,
      name: 'Agente B',
      email: 'agent-b@iso.test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'agent',
      active: true,
    })
    .returning({ id: base.users.id });
  assert.ok(bAdmin !== undefined && bAgent !== undefined, 'fixture users de B');

  const a = await seedSide(app, {
    tenantId: base.MILVENDAS_TENANT_ID,
    adminId: app.users.admin.id,
    tag: 'A',
    phone: PHONE_A,
  });
  const b = await seedSide(app, { tenantId: tenantB.id, adminId: bAdmin.id, tag: 'B', phone: PHONE_B });

  const [platformUser] = await app.db
    .insert(base.users)
    .values({
      tenantId: null, // CHECK: platform_admin não pertence a nenhum tenant
      name: 'Plataforma Iso',
      email: 'platform-iso@test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'platform_admin',
      active: true,
    })
    .returning({ id: base.users.id });
  assert.ok(platformUser !== undefined, 'fixture platform_admin');

  const store = createSessionStore({ db: app.db });
  const mkSess = async (userId: string, role: Role, mfaPending = false): Promise<Sess> => {
    const { sessionId } = await store.create({
      userId,
      role,
      mfaPending,
      now: new Date(),
      ttlHours: 72,
      ip: '127.0.0.1',
    });
    return { session: sessionId, csrf: randomUUID() };
  };

  return {
    tenantB: tenantB.id,
    a,
    b,
    sessions: {
      aAdmin: { session: app.sessions.admin, csrf: app.csrf.admin },
      bAdmin: await mkSess(bAdmin.id, 'admin'),
      platform: await mkSess(platformUser.id, 'platform_admin'),
    },
    platformUserId: platformUser.id,
    mkSess,
  };
}

/** Envio de um RouteSpec com uma sessão (csrf em todas as mutações). */
const call = (app: TestApp, route: RouteSpec, s: Sess) =>
  app.inject({
    method: route.method,
    url: route.url,
    cookies: { session: s.session, csrf: s.csrf },
    headers: {
      'x-csrf-token': s.csrf,
      ...(route.idempotencyKey !== undefined ? { 'idempotency-key': route.idempotencyKey } : {}),
    },
    ...(route.payload !== undefined ? { payload: route.payload } : {}),
  });

/** As 11 rotas de tenant REAIS (grep routes/*.ts — matriz fixada na T7). */
const tenantRoutes = (fx: Fixture): RouteSpec[] => [
  { method: 'GET', url: '/v1/users' },
  {
    method: 'POST',
    url: '/v1/users',
    payload: { name: 'Novo Iso', email: 'novo-iso@iso.test.local', role: 'agent', password: TEST_PASSWORD },
  },
  { method: 'PATCH', url: `/v1/users/${fx.b.adminId}`, payload: { name: 'Alterado Iso' } },
  { method: 'GET', url: '/v1/whatsapp-accounts' },
  { method: 'GET', url: `/v1/whatsapp-accounts/${fx.b.accountId}` },
  { method: 'POST', url: '/v1/whatsapp-accounts', payload: { label: 'Nova Iso', purpose: 'support' } },
  { method: 'POST', url: `/v1/whatsapp-accounts/${fx.b.accountId}/logout` },
  { method: 'GET', url: '/v1/conversations' },
  { method: 'GET', url: `/v1/conversations/${fx.b.conversationId}` },
  { method: 'GET', url: `/v1/conversations/${fx.b.conversationId}/messages` },
  {
    method: 'POST',
    url: `/v1/conversations/${fx.b.conversationId}/messages`,
    payload: { text: 'olá' },
    idempotencyKey: 'iso-tenant',
  },
];

/** As 7 rotas de plataforma REAIS (routes/platform.ts). */
const platformRoutes = (fx: Fixture): RouteSpec[] => [
  { method: 'GET', url: '/v1/platform/tenants' },
  { method: 'POST', url: `/v1/platform/tenants/${fx.tenantB}/suspend`, payload: {} },
  { method: 'POST', url: `/v1/platform/tenants/${fx.tenantB}/activate`, payload: {} },
  { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/users` },
  { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/accounts` },
  { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/conversations` },
  { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/conversations/${fx.b.conversationId}` },
];

/** As 6 rotas de tenant com :id — id do lado PASSADO (leitura E mutação). */
const foreignIdRoutes = (s: Side): RouteSpec[] => [
  { method: 'GET', url: `/v1/whatsapp-accounts/${s.accountId}` },
  { method: 'GET', url: `/v1/conversations/${s.conversationId}` },
  { method: 'GET', url: `/v1/conversations/${s.conversationId}/messages` },
  { method: 'PATCH', url: `/v1/users/${s.adminId}`, payload: { name: 'Hackeado' } },
  { method: 'POST', url: `/v1/whatsapp-accounts/${s.accountId}/logout` },
  {
    method: 'POST',
    url: `/v1/conversations/${s.conversationId}/messages`,
    payload: { text: 'olá' },
    idempotencyKey: 'iso-foreign',
  },
];

/** Nome do admin + estado do lado (prova de "nada mudou" após um 404/403). */
async function sideState(app: TestApp, side: Side) {
  const [user] = await app.db
    .select({ name: base.users.name })
    .from(base.users)
    .where(eq(base.users.id, side.adminId));
  const [acc] = await app.db
    .select({ status: base.whatsappAccounts.status })
    .from(base.whatsappAccounts)
    .where(eq(base.whatsappAccounts.id, side.accountId));
  const counts = await rowCounts(app.db, side.tenantId);
  return { adminName: user?.name, accountStatus: acc?.status, ...counts };
}

test('fixtures espelhados: A e B com o mesmo formato de linhas por tenant', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);
    const a = await rowCounts(app.db, fx.a.tenantId);
    const b = await rowCounts(app.db, fx.b.tenantId);
    assert.deepEqual(
      a,
      { accounts: 1, contacts: 1, leads: 1, conversations: 1, messages: 2, outbox: 1, campaigns: 1 },
      'lado A espelhado',
    );
    assert.deepEqual(b, a, 'lado B espelhado = lado A (mesmo formato de linhas)');

    // users: B tem exactamente admin+agent (A tem os 3 do harness + fixture)
    const usersB = await app.db
      .select({ role: base.users.role })
      .from(base.users)
      .where(eq(base.users.tenantId, fx.b.tenantId));
    assert.deepEqual(
      usersB.map((u) => u.role).sort(),
      ['admin', 'agent'],
      'B: admin + agent por direct insert',
    );
    const tenants = await app.db
      .select({ id: base.tenants.id, status: base.tenants.status })
      .from(base.tenants)
      .orderBy(base.tenants.id);
    assert.equal(tenants.length, 2, 'exactamente os dois tenants');
    assert.ok(tenants.every((t) => t.status === 'active'));
  } finally {
    await app.close();
  }
});

test('leitura E mutação por id alheio → 404 (6 rotas com :id, A sobre B e B sobre A)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);

    // A sobre B: todas as rotas com :id do outro tenant escondem a existência.
    const overB = foreignIdRoutes(fx.b);
    for (const route of overB) {
      const res = await call(app, route, fx.sessions.aAdmin);
      assert.equal(res.statusCode, 404, `${route.method} ${route.url} (sessão de A sobre id de B)`);
    }
    assert.equal(overB.length, 6, 'matriz: 6 rotas de tenant com :id (3 leitura + 3 mutação)');

    // Efeitos nulos no lado B: nada criado, nada renomeado, nada desconectado.
    const bAfter = await sideState(app, fx.b);
    assert.deepEqual(
      bAfter,
      { adminName: 'Admin B', accountStatus: 'connecting', accounts: 1, contacts: 1, leads: 1, conversations: 1, messages: 2, outbox: 1, campaigns: 1 },
      'lado B intacto após 6 pedidos alheios (404 sem efeitos)',
    );

    // Simetria: B sobre A → os mesmos 404 (o isolamento não é direcional).
    const overA = foreignIdRoutes(fx.a);
    for (const route of overA) {
      const res = await call(app, route, fx.sessions.bAdmin);
      assert.equal(res.statusCode, 404, `${route.method} ${route.url} (sessão de B sobre id de A)`);
    }
    assert.equal(overA.length, 6, 'matriz espelhada: 6 rotas');
    const aAfter = await sideState(app, fx.a);
    assert.deepEqual(
      aAfter,
      { adminName: 'Admin', accountStatus: 'connecting', accounts: 1, contacts: 1, leads: 1, conversations: 1, messages: 2, outbox: 1, campaigns: 1 },
      'lado A intacto após 6 pedidos alheios',
    );
  } finally {
    await app.close();
  }
});

test('listagens de tenant nunca contêm linhas do outro tenant (users, contas, conversas — A e B)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);

    const usersA = await call(app, { method: 'GET', url: '/v1/users' }, fx.sessions.aAdmin);
    assert.equal(usersA.statusCode, 200);
    assert.deepEqual(
      (usersA.json().users as Array<{ email: string }>).map((u) => u.email).sort(),
      ['admin@test.local', 'agent@test.local', 'editor@test.local'],
      'listagem de A: exactamente os users de A (nenhum email de B)',
    );

    const usersB = await call(app, { method: 'GET', url: '/v1/users' }, fx.sessions.bAdmin);
    assert.equal(usersB.statusCode, 200);
    assert.deepEqual(
      (usersB.json().users as Array<{ email: string }>).map((u) => u.email).sort(),
      ['admin-b@iso.test.local', 'agent-b@iso.test.local'],
      'listagem de B: exactamente os users de B (nenhum email de A)',
    );

    const accA = await call(app, { method: 'GET', url: '/v1/whatsapp-accounts' }, fx.sessions.aAdmin);
    assert.deepEqual(
      (accA.json().accounts as Array<{ id: string }>).map((x) => x.id),
      [fx.a.accountId],
      'contas de A: só a conta de A',
    );
    const accB = await call(app, { method: 'GET', url: '/v1/whatsapp-accounts' }, fx.sessions.bAdmin);
    assert.deepEqual(
      (accB.json().accounts as Array<{ id: string }>).map((x) => x.id),
      [fx.b.accountId],
      'contas de B: só a conta de B',
    );

    const convA = await call(app, { method: 'GET', url: '/v1/conversations' }, fx.sessions.aAdmin);
    assert.deepEqual(
      (convA.json().conversations as Array<{ id: string }>).map((x) => x.id),
      [fx.a.conversationId],
      'conversas de A: só a conversa de A',
    );
    const convB = await call(app, { method: 'GET', url: '/v1/conversations' }, fx.sessions.bAdmin);
    assert.deepEqual(
      (convB.json().conversations as Array<{ id: string }>).map((x) => x.id),
      [fx.b.conversationId],
      'conversas de B: só a conversa de B',
    );
  } finally {
    await app.close();
  }
});

test('rota de plataforma com sessão de tenant → 403 nas 7 rotas (estado intacto)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);
    const routes = platformRoutes(fx);
    for (const route of routes) {
      const res = await call(app, route, fx.sessions.aAdmin);
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(res.json().title, 'forbidden', `${route.method} ${route.url} → forbidden`);
    }
    assert.equal(routes.length, 7, 'matriz cobre as 7 rotas de plataforma');

    // O 403 veio do guard: nada de suspender, activar ou auditar.
    const [tenant] = await app.db
      .select({ status: base.tenants.status })
      .from(base.tenants)
      .where(eq(base.tenants.id, fx.tenantB));
    assert.equal(tenant?.status, 'active', 'tenant B continua activo');
    const lifecycle = await app.db
      .select({ action: base.auditLog.action })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'tenant.suspend'));
    assert.equal(lifecycle.length, 0, 'nenhum audit de ciclo de vida gravado');
  } finally {
    await app.close();
  }
});

test('rota de tenant com sessão platform → 403 nas 11 rotas (requireTenant; sem overblock)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);
    const routes = tenantRoutes(fx);
    for (const route of routes) {
      const res = await call(app, route, fx.sessions.platform);
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(res.json().title, 'forbidden', `${route.method} ${route.url} → forbidden`);
    }
    assert.equal(routes.length, 11, 'matriz cobre as 11 rotas de tenant (T7)');

    // Estado intacto: nada foi criado/alterado dentro de tenant pela plataforma.
    const bAfter = await sideState(app, fx.b);
    assert.deepEqual(
      bAfter,
      { adminName: 'Admin B', accountStatus: 'connecting', accounts: 1, contacts: 1, leads: 1, conversations: 1, messages: 2, outbox: 1, campaigns: 1 },
      'lado B intacto após 11 pedidos da plataforma',
    );
    const usersTotal = await app.db.select({ id: base.users.id }).from(base.users);
    assert.equal(usersTotal.length, 6, 'nenhum utilizador forjado (3 A + 2 B + 1 platform)');

    // Sem overblock: os âmbitos legítimos da plataforma continuam abertos.
    const me = await call(app, { method: 'GET', url: '/v1/auth/me' }, fx.sessions.platform);
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().scope, 'platform');
    const list = await call(app, { method: 'GET', url: '/v1/platform/tenants' }, fx.sessions.platform);
    assert.equal(list.statusCode, 200, 'rota de plataforma continua acessível à plataforma');
  } finally {
    await app.close();
  }
});

test('sessão mfaPending → 403 mfa_required em qualquer rota fora da MFA allowlist', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);
    const tenantMfa = await fx.mkSess(app.users.admin.id, 'admin', true);
    const platformMfa = await fx.mkSess(fx.platformUserId, 'platform_admin', true);
    const authExtra: RouteSpec[] = [
      { method: 'GET', url: '/v1/auth/me' },
      {
        method: 'POST',
        url: '/v1/auth/password',
        payload: { currentPassword: TEST_PASSWORD, newPassword: 'outra-senha-forte-456' },
      },
    ];

    // 11 rotas de tenant + 2 rotas auth = 13 com sessão de tenant mfaPending.
    const tenantMfaRoutes = [...tenantRoutes(fx), ...authExtra];
    for (const route of tenantMfaRoutes) {
      const res = await call(app, route, tenantMfa);
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(res.json().title, 'mfa_required', `${route.method} ${route.url} → mfa_required`);
    }
    assert.equal(tenantMfaRoutes.length, 13, '13 rotas com sessão de tenant mfaPending');

    // 7 rotas de plataforma + 2 rotas auth = 9 com sessão platform mfaPending.
    const platformMfaRoutes = [...platformRoutes(fx), ...authExtra];
    for (const route of platformMfaRoutes) {
      const res = await call(app, route, platformMfa);
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(res.json().title, 'mfa_required', `${route.method} ${route.url} → mfa_required`);
    }
    assert.equal(platformMfaRoutes.length, 9, '9 rotas com sessão platform mfaPending');

    // A recusa veio do authenticate: nada mudou na BD (state-intact).
    const bAfter = await sideState(app, fx.b);
    assert.deepEqual(
      bAfter,
      { adminName: 'Admin B', accountStatus: 'connecting', accounts: 1, contacts: 1, leads: 1, conversations: 1, messages: 2, outbox: 1, campaigns: 1 },
      'lado B intacto com sessões mfaPending',
    );

    // MFA_ALLOWLIST intacta (3 rotas, todas exercitadas com sessão pendente).
    const sSetup = await fx.mkSess(app.users.admin.id, 'admin', true);
    const setup = await call(app, { method: 'POST', url: '/v1/auth/totp/setup' }, sSetup);
    assert.equal(setup.statusCode, 200, 'allowlist: POST /v1/auth/totp/setup segue acessível');

    const sVerify = await fx.mkSess(app.users.admin.id, 'admin', true);
    const verify = await call(
      app,
      { method: 'POST', url: '/v1/auth/totp/verify', payload: { code: '123456' } },
      sVerify,
    );
    assert.equal(verify.statusCode, 200, 'allowlist: POST /v1/auth/totp/verify conclui o MFA');
    assert.equal(verify.json().ok, true);
    const meAfter = await call(app, { method: 'GET', url: '/v1/auth/me' }, sVerify);
    assert.equal(meAfter.statusCode, 200, 'mfaPending limpo: a sessão passa a operar normalmente');

    const sLogout = await fx.mkSess(app.users.admin.id, 'admin', true);
    const logout = await call(app, { method: 'POST', url: '/v1/auth/logout' }, sLogout);
    assert.equal(logout.statusCode, 204, 'allowlist: POST /v1/auth/logout continua acessível');

    const sPlatformSetup = await fx.mkSess(fx.platformUserId, 'platform_admin', true);
    const platformSetup = await call(app, { method: 'POST', url: '/v1/auth/totp/setup' }, sPlatformSetup);
    assert.equal(platformSetup.statusCode, 200, 'allowlist simétrica para platform_admin');
  } finally {
    await app.close();
  }
});

test('tenant suspenso → 403 tenant_suspended em qualquer rota de tenant (spec §8.2)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);
    await app.db
      .update(base.tenants)
      .set({ status: 'suspended' })
      .where(eq(base.tenants.id, fx.tenantB));

    // Sessão de B: qualquer rota autenticada de tenant é recusada no authenticate.
    for (const route of [
      { method: 'GET', url: '/v1/conversations' },
      { method: 'GET', url: '/v1/auth/me' },
      { method: 'POST', url: '/v1/users', payload: { name: 'X', email: 'x@iso.test.local', role: 'agent', password: TEST_PASSWORD } },
    ] satisfies RouteSpec[]) {
      const res = await call(app, route, fx.sessions.bAdmin);
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
      assert.equal(res.json().title, 'tenant_suspended', `${route.method} ${route.url} → tenant_suspended`);
    }

    // A suspensão é do TENANT: a plataforma continua a operar.
    const list = await call(app, { method: 'GET', url: '/v1/platform/tenants' }, fx.sessions.platform);
    assert.equal(list.statusCode, 200);

    // Repor → as rotas de B voltam a passar (controle positivo).
    await app.db
      .update(base.tenants)
      .set({ status: 'active' })
      .where(eq(base.tenants.id, fx.tenantB));
    const restored = await call(app, { method: 'GET', url: '/v1/conversations' }, fx.sessions.bAdmin);
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(
      (restored.json().conversations as Array<{ id: string }>).map((x) => x.id),
      [fx.b.conversationId],
      'reativado: B volta a ver a sua conversa',
    );
    const forged = await app.db
      .select({ id: base.users.id })
      .from(base.users)
      .where(eq(base.users.email, 'x@iso.test.local'));
    assert.equal(forged.length, 0, 'nenhum utilizador criado durante a suspensão');
  } finally {
    await app.close();
  }
});

test('drill de plataforma com :id fora do tenant perfurado → 404 (leitura cruzada escondida)', async () => {
  const app = await buildTestApp();
  try {
    const fx = await seedMirror(app);

    // Drill do tenant B com a CONVERSA de A → 404 (scope do path não vaza).
    const cross = await call(
      app,
      { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/conversations/${fx.a.conversationId}` },
      fx.sessions.platform,
    );
    assert.equal(cross.statusCode, 404);

    // Espelho: drill do tenant MilVendas com a conversa de B → 404.
    const crossBack = await call(
      app,
      { method: 'GET', url: `/v1/platform/tenants/${base.MILVENDAS_TENANT_ID}/conversations/${fx.b.conversationId}` },
      fx.sessions.platform,
    );
    assert.equal(crossBack.statusCode, 404);

    // Controle positivo: a conversa PRÓPRIA do tenant perfurado continua 200.
    const own = await call(
      app,
      { method: 'GET', url: `/v1/platform/tenants/${fx.tenantB}/conversations/${fx.b.conversationId}` },
      fx.sessions.platform,
    );
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().conversation.id, fx.b.conversationId);
  } finally {
    await app.close();
  }
});
