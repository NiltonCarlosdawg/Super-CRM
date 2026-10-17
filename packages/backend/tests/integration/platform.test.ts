// Onda 1, Task 7 (spec multitenant §5.3): superfície /v1/platform/* — lista de
// tenants com contagens, ciclo de vida (suspend/activate) e drill read-only de
// suporte auditado (`platform.view_tenant` no PRIMEIRO acesso a cada tenant).
// Guardas: `requirePlatform` em TODAS as rotas de plataforma (sessão mfaPending
// fica fora do MFA_ALLOWLIST → 403 mfa_required) e `requireTenant` em TODAS as
// rotas de tenant (ruling R2/R15 — plataforma numa rota de tenant → 403, nunca
// uma query sem âmbito). Escrita dentro de tenant por plataforma = 403 em v1.
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/http.js';

interface PlatformSession {
  session: string;
  csrf: string;
  userId: string;
}

/** Linha de platform_admin directa (CHECK: tenant_id NULL) — primeiro passo. */
async function mkPlatformUser(app: TestApp): Promise<string> {
  const hasher = createArgon2Hasher();
  const [row] = await app.db
    .insert(base.users)
    .values({
      tenantId: null,
      name: 'Plataforma',
      email: 'platform@test.local',
      passwordHash: await hasher.hash(TEST_PASSWORD),
      role: 'platform_admin',
      active: true,
    })
    .returning({ id: base.users.id });
  assert.ok(row !== undefined, 'fixture platform_admin');
  return row.id;
}

/** Login HTTP da plataforma (cookies de sessão + csrf da própria resposta). */
async function loginPlatform(app: TestApp): Promise<PlatformSession> {
  const userId = await mkPlatformUser(app);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'platform@test.local', password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 200, `login platform: ${login.body}`);
  const session = login.cookies.find((c) => c.name === 'session')?.value ?? '';
  const csrf = login.cookies.find((c) => c.name === 'csrf')?.value ?? '';
  assert.ok(session !== '' && csrf !== '', 'cookies session+csrf do login');
  return { session, csrf, userId };
}

const get = (app: TestApp, url: string, session: string) =>
  app.inject({ method: 'GET', url, cookies: { session } });

const post = (app: TestApp, url: string, p: PlatformSession, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    cookies: { session: p.session, csrf: p.csrf },
    headers: { 'x-csrf-token': p.csrf },
    payload,
  });

test('platform_admin lista tenants com contagens', async () => {
  const app = await buildTestApp();
  try {
    const p = await loginPlatform(app);

    // segundo tenant com 1 user + 1 conta (contagens espelhadas)
    const [beta] = await app.db
      .insert(base.tenants)
      .values({ name: 'Beta LDA' })
      .returning({ id: base.tenants.id });
    assert.ok(beta !== undefined);
    await app.db.insert(base.users).values({
      tenantId: beta.id,
      name: 'Beta Admin',
      email: 'beta-admin@test.local',
      passwordHash: 'hash-fake',
      role: 'admin',
      active: true,
    });
    await app.accounts.create(
      { tenantId: beta.id },
      { label: 'B1', purpose: 'support', providerSessionId: 'sess-b1', now: new Date() },
    );

    const res = await get(app, '/v1/platform/tenants', p.session);
    assert.equal(res.statusCode, 200);
    const list = res.json() as Array<{
      id: string;
      name: string;
      status: string;
      usersCount: number;
      accountsCount: number;
      createdAt: string;
    }>;
    assert.ok(Array.isArray(list), 'resposta = lista directa [{...}] (contrato do brief)');

    const mil = list.find((t) => t.id === base.MILVENDAS_TENANT_ID);
    const betaRow = list.find((t) => t.id === beta.id);
    assert.ok(mil !== undefined && betaRow !== undefined, 'os dois tenants presentes');
    assert.deepEqual(
      { name: mil.name, status: mil.status, usersCount: mil.usersCount, accountsCount: mil.accountsCount },
      { name: 'MilVendas', status: 'active', usersCount: 3, accountsCount: 0 },
      'MilVendas: agent/editor/admin e nenhuma conta',
    );
    assert.deepEqual(
      { usersCount: betaRow.usersCount, accountsCount: betaRow.accountsCount },
      { usersCount: 1, accountsCount: 1 },
      'Beta: 1 user + 1 conta',
    );
    assert.ok(typeof mil.createdAt === 'string', 'createdAt serializado');
    // contrato exacto dos campos do brief (nada mais, nada menos)
    assert.deepEqual(Object.keys(mil).sort(), [
      'accountsCount',
      'createdAt',
      'id',
      'name',
      'status',
      'usersCount',
    ]);
    assert.equal(list.length, 2, 'o platform_admin (tenant_id NULL) não é tenant');
  } finally {
    await app.close();
  }
});

test('suspend → tenants.status suspended + audit tenant.suspend; activate repõe', async () => {
  const app = await buildTestApp();
  try {
    const p = await loginPlatform(app);

    const susp = await post(app, `/v1/platform/tenants/${base.MILVENDAS_TENANT_ID}/suspend`, p);
    assert.equal(susp.statusCode, 204);
    const afterSusp = await app.db
      .select()
      .from(base.tenants)
      .where(eq(base.tenants.id, base.MILVENDAS_TENANT_ID));
    assert.equal(afterSusp[0]?.status, 'suspended');

    const auditSusp = await app.db
      .select()
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'tenant.suspend'));
    assert.equal(auditSusp.length, 1, 'audit tenant.suspend exactamente 1');
    assert.deepEqual(
      { tenantId: auditSusp[0]?.tenantId, actorId: auditSusp[0]?.actorId, entityId: auditSusp[0]?.entityId },
      { tenantId: base.MILVENDAS_TENANT_ID, actorId: p.userId, entityId: base.MILVENDAS_TENANT_ID },
      'audit com o tenant AFETADO e o platform_admin como actor (spec §5.4)',
    );

    // utilizadores do tenant passam a 403 tenant_suspended em qualquer pedido
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      cookies: { session: app.sessions.admin },
    });
    assert.equal(me.statusCode, 403);
    assert.equal(me.json().title, 'tenant_suspended');

    // invariante do CHECK: suspender NÃO toca em users (status vive em tenants)
    const adminRow = await app.db
      .select()
      .from(base.users)
      .where(eq(base.users.id, app.users.admin.id));
    assert.deepEqual(
      { role: adminRow[0]?.role, tenantId: adminRow[0]?.tenantId, active: adminRow[0]?.active },
      { role: 'admin', tenantId: base.MILVENDAS_TENANT_ID, active: true },
      'users intocado pela suspensão',
    );

    const act = await post(app, `/v1/platform/tenants/${base.MILVENDAS_TENANT_ID}/activate`, p);
    assert.equal(act.statusCode, 204);
    const afterAct = await app.db
      .select()
      .from(base.tenants)
      .where(eq(base.tenants.id, base.MILVENDAS_TENANT_ID));
    assert.equal(afterAct[0]?.status, 'active');
    const auditAct = await app.db
      .select()
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'tenant.activate'));
    assert.equal(auditAct.length, 1);
    assert.equal(auditAct[0]?.tenantId, base.MILVENDAS_TENANT_ID);
    const meAgain = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      cookies: { session: app.sessions.admin },
    });
    assert.equal(meAgain.statusCode, 200, 'reativado → pedidos voltam a passar');

    // tenant inexistente → 404 (nunca audit com FK a falhar, nunca 204 silencioso)
    const missing = await post(app, `/v1/platform/tenants/${randomUUID()}/suspend`, p);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().title, 'not_found');
  } finally {
    await app.close();
  }
});

test('drill read-only devolve users/contas/conversas do tenant pedido (+ 1º acesso auditado)', async () => {
  const app = await buildTestApp();
  try {
    const p = await loginPlatform(app);

    // fixture sintética: conta + contacto + conversa + mensagem no tenant MilVendas
    const { id: accId } = await app.accounts.create(
      { tenantId: base.MILVENDAS_TENANT_ID },
      { label: 'Drill', purpose: 'support', providerSessionId: 'sess-drill', now: new Date() },
    );
    const [contact] = await app.db
      .insert(base.contacts)
      .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923777222' })
      .returning({ id: base.contacts.id });
    assert.ok(contact !== undefined);
    const [conv] = await app.db
      .insert(base.conversations)
      .values({
        tenantId: base.MILVENDAS_TENANT_ID,
        accountId: accId,
        contactId: contact.id,
      })
      .returning({ id: base.conversations.id });
    assert.ok(conv !== undefined);
    await app.db.insert(base.messages).values({
      tenantId: base.MILVENDAS_TENANT_ID,
      conversationId: conv.id,
      accountId: accId,
      direction: 'inbound',
      sender: 'customer',
      body: 'olá da drill',
      status: 'sent',
    });

    const T = base.MILVENDAS_TENANT_ID;
    const users = await get(app, `/v1/platform/tenants/${T}/users`, p.session);
    assert.equal(users.statusCode, 200);
    assert.deepEqual(
      (users.json().users as Array<{ email: string }>).map((u) => u.email),
      ['admin@test.local', 'agent@test.local', 'editor@test.local'],
      'só os users do tenant pedido (sem platform, sem outros tenants)',
    );

    const accounts = await get(app, `/v1/platform/tenants/${T}/accounts`, p.session);
    assert.equal(accounts.statusCode, 200);
    assert.deepEqual(
      (accounts.json().accounts as Array<{ id: string; label: string }>).map((a) => ({ id: a.id, label: a.label })),
      [{ id: accId, label: 'Drill' }],
    );

    const convs = await get(app, `/v1/platform/tenants/${T}/conversations`, p.session);
    assert.equal(convs.statusCode, 200);
    assert.deepEqual(
      (convs.json().conversations as Array<{ id: string }>).map((c) => c.id),
      [conv.id],
    );

    const thread = await get(app, `/v1/platform/tenants/${T}/conversations/${conv.id}`, p.session);
    assert.equal(thread.statusCode, 200);
    assert.equal(thread.json().conversation.id, conv.id);
    assert.equal(thread.json().lastMessage.body, 'olá da drill');

    // PRIMEIRO acesso ao tenant auditado UMA única vez (spec §5.3)
    const views = await app.db
      .select()
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'platform.view_tenant'));
    assert.equal(views.length, 1, 'platform.view_tenant só no primeiro acesso ao tenant');
    assert.deepEqual(
      { tenantId: views[0]?.tenantId, actorId: views[0]?.actorId, entityId: views[0]?.entityId },
      { tenantId: T, actorId: p.userId, entityId: T },
      'audit ligado ao tenant PERFURADO e ao platform_admin',
    );

    // tenant inexistente → 404 e NENHUM audit (sem 500 pela FK do audit_log)
    const missing = await get(app, `/v1/platform/tenants/${randomUUID()}/users`, p.session);
    assert.equal(missing.statusCode, 404);
    const viewsAfter = await app.db
      .select()
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'platform.view_tenant'));
    assert.equal(viewsAfter.length, 1, '404 não audita nem conta como acesso');

    // conversa inexistente no tenant → 404
    const noConv = await get(
      app,
      `/v1/platform/tenants/${T}/conversations/${randomUUID()}`,
      p.session,
    );
    assert.equal(noConv.statusCode, 404);

    // read-only: o drill NÃO tem rotas de escrita (POST → 404, sem forjar nada)
    const write = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${T}/users`,
      cookies: { session: p.session, csrf: p.csrf },
      headers: { 'x-csrf-token': p.csrf },
      payload: { name: 'Forjado', email: 'forjado@test.local', role: 'agent', password: TEST_PASSWORD },
    });
    assert.equal(write.statusCode, 404, 'nenhuma rota de escrita no drill');
    const forged = await app.db
      .select()
      .from(base.users)
      .where(eq(base.users.email, 'forjado@test.local'));
    assert.equal(forged.length, 0);
  } finally {
    await app.close();
  }
});

test('sessão de tenant em /v1/platform/* → 403', async () => {
  const app = await buildTestApp();
  try {
    const T = base.MILVENDAS_TENANT_ID;
    const tenantReqs: Array<{ method: 'GET' | 'POST'; url: string }> = [
      { method: 'GET', url: '/v1/platform/tenants' },
      { method: 'GET', url: `/v1/platform/tenants/${T}/users` },
      { method: 'GET', url: `/v1/platform/tenants/${T}/accounts` },
      { method: 'GET', url: `/v1/platform/tenants/${T}/conversations` },
      { method: 'POST', url: `/v1/platform/tenants/${T}/suspend` },
      { method: 'POST', url: `/v1/platform/tenants/${T}/activate` },
    ];
    for (const req of tenantReqs) {
      const res =
        req.method === 'GET'
          ? await app.inject({ method: 'GET', url: req.url, cookies: { session: app.sessions.admin } })
          : await app.inject({
              method: 'POST',
              url: req.url,
              cookies: { session: app.sessions.admin, csrf: app.csrf.admin },
              headers: { 'x-csrf-token': app.csrf.admin },
            });
      assert.equal(res.statusCode, 403, `${req.method} ${req.url}`);
      assert.equal(res.json().title, 'forbidden', `${req.method} ${req.url}`);
    }
    // estado intacto: o 403 veio do guard, não de efeitos secundários
    const rows = await app.db
      .select()
      .from(base.tenants)
      .where(eq(base.tenants.id, T));
    assert.equal(rows[0]?.status, 'active');
  } finally {
    await app.close();
  }
});

test('sessão mfaPending (mesmo platform_admin) em /v1/platform/* → 403 (fora do MFA_ALLOWLIST)', async () => {
  const app = await buildTestApp();
  try {
    const userId = await mkPlatformUser(app);
    const sessions = createSessionStore({ db: app.db });
    const { sessionId } = await sessions.create({
      userId,
      role: 'platform_admin',
      mfaPending: true,
      now: new Date(),
      ttlHours: 72,
      ip: '127.0.0.1',
    });

    const csrf = randomUUID();
    const list = await app.inject({
      method: 'GET',
      url: '/v1/platform/tenants',
      cookies: { session: sessionId },
    });
    assert.equal(list.statusCode, 403, 'GET /v1/platform/* com mfaPending');
    assert.equal(list.json().title, 'mfa_required');

    const susp = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${base.MILVENDAS_TENANT_ID}/suspend`,
      cookies: { session: sessionId, csrf },
      headers: { 'x-csrf-token': csrf },
    });
    assert.equal(susp.statusCode, 403, 'POST /v1/platform/* com mfaPending');
    assert.equal(susp.json().title, 'mfa_required', 'recusado pelo authenticate, não pelo csrf');

    // prova que a sessão É válida: a allowlist continua a deixa-la terminar o MFA
    const setup = await app.inject({
      method: 'POST',
      url: '/v1/auth/totp/setup',
      cookies: { session: sessionId, csrf },
      headers: { 'x-csrf-token': csrf },
    });
    assert.equal(setup.statusCode, 200, 'rota da allowlist segue acessível com mfaPending');
  } finally {
    await app.close();
  }
});

test('platform_admin NÃO tem escrita dentro de tenant: POST /v1/users com sessão platform → 403', async () => {
  const app = await buildTestApp();
  try {
    const p = await loginPlatform(app);

    const create = await post(app, '/v1/users', p, {
      name: 'Forjado',
      email: 'forjado@test.local',
      role: 'agent',
      password: TEST_PASSWORD,
    });
    assert.equal(create.statusCode, 403);
    assert.equal(create.json().title, 'forbidden');
    const forged = await app.db
      .select()
      .from(base.users)
      .where(eq(base.users.email, 'forjado@test.local'));
    assert.equal(forged.length, 0, 'nada criado dentro do tenant');

    // PATCH (mutação existente) e resto da superfície de escrita de tenant
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${app.users.agent.id}`,
      cookies: { session: p.session, csrf: p.csrf },
      headers: { 'x-csrf-token': p.csrf },
      payload: { active: false },
    });
    assert.equal(patch.statusCode, 403);

    const account = await post(app, '/v1/whatsapp-accounts', p, {
      label: 'Forjada',
      purpose: 'support',
    });
    assert.equal(account.statusCode, 403);

    const send = await post(
      app,
      `/v1/conversations/${randomUUID()}/messages`,
      p,
      { text: 'olá' },
    );
    // (o Idempotency-Key é exigido no handler; o requireTenant recusa ANTES)
    assert.equal(send.statusCode, 403);
    assert.equal(send.json().title, 'forbidden');
  } finally {
    await app.close();
  }
});

test('sessão platform em qualquer rota de tenant → 403 (requireTenant, R2/R15)', async () => {
  const app = await buildTestApp();
  try {
    const p = await loginPlatform(app);

    // superfície de tenant inteira: 403 forbidden — incluindo as rotas anyRole
    // (antes desta task respondiam 200 vazio/null com scope nulo — fail-safe 404)
    const tenantReqs: Array<{ method: 'GET' | 'PATCH' | 'POST'; url: string; payload?: unknown }> = [
      { method: 'GET', url: '/v1/users' },
      { method: 'GET', url: '/v1/whatsapp-accounts' },
      { method: 'GET', url: '/v1/whatsapp-accounts/' + randomUUID() },
      { method: 'GET', url: '/v1/conversations' },
      { method: 'GET', url: `/v1/conversations/${randomUUID()}` },
      { method: 'GET', url: `/v1/conversations/${randomUUID()}/messages` },
      { method: 'POST', url: `/v1/conversations/${randomUUID()}/messages`, payload: { text: 'oi' } },
      { method: 'POST', url: '/v1/users', payload: {} },
      { method: 'PATCH', url: `/v1/users/${app.users.agent.id}`, payload: { active: false } },
      { method: 'POST', url: '/v1/whatsapp-accounts', payload: { label: 'X', purpose: 'support' } },
    ];
    for (const req of tenantReqs) {
      const res = await app.inject({
        method: req.method,
        url: req.url,
        cookies: { session: p.session, csrf: p.csrf },
        headers: { 'x-csrf-token': p.csrf },
        ...(req.payload !== undefined ? { payload: req.payload } : {}),
      });
      assert.equal(res.statusCode, 403, `${req.method} ${req.url}`);
      assert.equal(res.json().title, 'forbidden', `${req.method} ${req.url}`);
    }

    // âmbitos legítimos da plataforma continuam abertos (não houve overblock)
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      cookies: { session: p.session },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().scope, 'platform');
    const list = await get(app, '/v1/platform/tenants', p.session);
    assert.equal(list.statusCode, 200, 'rota de plataforma continua acessível à plataforma');
  } finally {
    await app.close();
  }
});
