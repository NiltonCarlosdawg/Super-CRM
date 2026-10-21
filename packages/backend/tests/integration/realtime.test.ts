// Fase 1, Task 15: Socket.IO — handshake autenticado por cookie de sessão,
// salas por papel e mapeamento dos 5 eventos do painel (docs/02 §9).
// Cliente socket.io-client real contra o servidor do buildTestApp.
// Onda 1 (R31): salas por TENANT — um evento de um tenant nunca chega aos
// sockets de outro tenant, nem aos de plataforma (que não têm salas de tenant).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { createSessionStore } from '../../src/adapters/db/auth.js';
import { MILVENDAS_TENANT_ID, tenants } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import {
  createSocketNotify,
  type NotifyEvent,
  type SocketIoLike,
} from '../../src/adapters/realtime/socket.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

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

async function connectClient(app: TestApp, role: 'agent' | 'editor' | 'admin'): Promise<Socket> {
  const client = await connectClientRaw(app, app.sessions[role]);
  clients.push(client);
  return client;
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

async function closeClients(): Promise<void> {
  for (const client of clients.splice(0)) client.close();
}

test('salas por papel: agent vê message.created e handoff.created, editor NÃO vê handoff, admin vê account.status', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const agent = await connectClient(app, 'agent');
  const editor = await connectClient(app, 'editor');
  const admin = await connectClient(app, 'admin');
  const notify = createSocketNotify(app.realtime.io);

  const got = collect(agent, 'message.created');
  const agentHandoff = collect(agent, 'handoff.created');
  const noHandoff = collect(editor, 'handoff.created');
  const gotAcct = collect(admin, 'account.status');
  const agentNoAcct = collect(agent, 'account.status');

  await notify({
    type: 'message', phase: 'created', tenantId: MILVENDAS_TENANT_ID, messageId: 'm1', conversationId: 'c1',
  });
  await notify({
    type: 'handoff', tenantId: MILVENDAS_TENANT_ID, handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r',
  });
  await notify({ type: 'account', tenantId: MILVENDAS_TENANT_ID, accountId: 'a1', status: 'connected' });

  assert.deepEqual(await got, { v: 1, messageId: 'm1', conversationId: 'c1' });
  assert.deepEqual(await agentHandoff, { v: 1, handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r' });
  assert.equal(await noHandoff, null, 'editor fora da sala handoffs (docs/02 §9)');
  assert.deepEqual(await gotAcct, { v: 1, accountId: 'a1', status: 'connected' });
  assert.equal(await agentNoAcct, null, 'account.status só para admin');

  await closeClients();
  await app.close();
});

// ── R31: isolamento de tenant no canal realtime ──

/** Tenant B sintético + user agent (mesmo padrão do repo-scope.test.ts). */
async function seedTenantBAgent(app: TestApp): Promise<{ tenantId: string; sessionId: string }> {
  const [tenantB] = await app.db
    .insert(tenants)
    .values({ id: randomUUID(), name: 'Empresa B (sintética)' })
    .returning({ id: tenants.id });
  if (tenantB === undefined) throw new Error('falhou criar tenant B');
  const [userB] = await app.db
    .insert(users)
    .values({
      tenantId: tenantB.id,
      name: 'Agente B',
      email: 'agent-b@empresa-b.test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'agent',
      active: true,
    })
    .returning({ id: users.id });
  if (userB === undefined) throw new Error('falhou criar user B');
  // Sessão directa (sem login): o handshake só precisa do cookie `session`.
  const { sessionId } = await createSessionStore({ db: app.db }).create({
    userId: userB.id,
    role: 'agent',
    mfaPending: false,
    now: new Date(),
    ttlHours: 72,
    ip: '127.0.0.1',
  });
  return { tenantId: tenantB.id, sessionId };
}

/** platform_admin (tenantId null) + sessão directa — liga, mas sem salas de tenant. */
async function seedPlatformSession(app: TestApp): Promise<string> {
  const [platform] = await app.db
    .insert(users)
    .values({
      tenantId: null,
      name: 'Plataforma',
      email: 'platform@test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'platform_admin',
      active: true,
    })
    .returning({ id: users.id });
  if (platform === undefined) throw new Error('falhou criar user de plataforma');
  const { sessionId } = await createSessionStore({ db: app.db }).create({
    userId: platform.id,
    role: 'platform_admin',
    mfaPending: false,
    now: new Date(),
    ttlHours: 72,
    ip: '127.0.0.1',
  });
  return sessionId;
}

test('salas por tenant (R31): evento de B só chega a B; A e plataforma ficam sem eventos', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const tenantB = await seedTenantBAgent(app);
    const platformSession = await seedPlatformSession(app);

    const agentA = await connectClient(app, 'agent');
    const agentB = await connectClientRaw(app, tenantB.sessionId);
    clients.push(agentB);
    const platform = await connectClientRaw(app, platformSession);
    clients.push(platform);
    const notify = createSocketNotify(app.realtime.io);

    // Evento do tenant B: só o socket de B o recebe.
    const bGot = collect(agentB, 'message.created');
    const aGot = collect(agentA, 'message.created');
    const platGot = collect(platform, 'message.created');
    await notify({
      type: 'message', phase: 'created', tenantId: tenantB.tenantId, messageId: 'm-b', conversationId: 'c-b',
    });
    assert.deepEqual(await bGot, { v: 1, messageId: 'm-b', conversationId: 'c-b' }, 'B recebe o seu evento');
    assert.equal(await aGot, null, 'socket de A NUNCA recebe eventos do tenant B (R31)');
    assert.equal(await platGot, null, 'plataforma não tem salas de tenant (R31)');

    // Inverso: evento de A nunca chega a B.
    const aGot2 = collect(agentA, 'message.created');
    const bGot2 = collect(agentB, 'message.created');
    await notify({
      type: 'message', phase: 'created', tenantId: MILVENDAS_TENANT_ID, messageId: 'm-a', conversationId: 'c-a',
    });
    assert.deepEqual(await aGot2, { v: 1, messageId: 'm-a', conversationId: 'c-a' }, 'A recebe o seu evento');
    assert.equal(await bGot2, null, 'socket de B NUNCA recebe eventos do tenant A (R31)');

    // handoff: sala por papel + tenant (agent de B vê, agent de A não).
    const bHandoff = collect(agentB, 'handoff.created');
    const aHandoff = collect(agentA, 'handoff.created');
    await notify({
      type: 'handoff', tenantId: tenantB.tenantId, handoffId: 'h-b', conversationId: 'c-b',
      priority: 'high', reason: 'r',
    });
    assert.deepEqual(
      await bHandoff,
      { v: 1, handoffId: 'h-b', conversationId: 'c-b', priority: 'high', reason: 'r' },
      'handoff do tenant B chega a B',
    );
    assert.equal(await aHandoff, null, 'handoff de B NUNCA chega ao agent de A (R31)');
  } finally {
    await closeClients();
    await app.close();
  }
});

test('notify sem tenantId não emite para lado nenhum (fail-closed, R31)', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const agent = await connectClient(app, 'agent');
    const notify = createSocketNotify(app.realtime.io);

    const got = collect(agent, 'message.created');
    // Evento sem tenant = sem sala segura ⇒ nunca sai (defesa em profundidade
    // do type `tenantId: string`, obrigatório desde o fix R31).
    await notify({
      type: 'message', phase: 'created', messageId: 'm1', conversationId: 'c1',
    } as unknown as NotifyEvent);
    assert.equal(await got, null, 'evento sem tenant é descartado, não vai para sala global');
  } finally {
    await closeClients();
    await app.close();
  }
});

test('handshake sem sessão ou expirada → connect_error', async () => {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  await assert.rejects(() => connectClientRaw(app, 'sessao-inexistente'), /unauthorized/);
  await app.close();
});

test('mapeamento: payload extra sobrevive e só saem os 5 eventos (espião de io.to().emit)', async () => {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const fake: SocketIoLike = {
    to: (room) => ({
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
      },
    }),
  };
  const notify = createSocketNotify(fake);

  await notify({
    type: 'handoff', tenantId: 'tenant-x', handoffId: 'h1', conversationId: 'c1', priority: 'normal', reason: 'r',
    outsideHours: true, opensAt: '2026-10-08T08:00:00Z',
  });
  await notify({
    type: 'handoff', phase: 'updated', tenantId: 'tenant-x', handoffId: 'h1', conversationId: 'c1',
    priority: 'high', reason: 'r2',
  });
  await notify({ type: 'alert', tenantId: 'tenant-x', reason: 'opening_pending', handoffId: 'h1' });
  await notify({
    type: 'flag', tenantId: 'tenant-x', handoffId: 'h2', conversationId: 'c1', priority: 'normal', reason: 'f',
  });
  await notify({ type: 'message', phase: 'status', tenantId: 'tenant-x', messageId: 'm1', status: 'sent' });
  await notify({ type: 'wat' } as never);

  assert.deepEqual(
    emitted.map((e) => e.event),
    [
      'handoff.created', // handoff sem phase → 1 sala (handoffs)
      'handoff.updated', // handoff phase 'updated'
      'handoff.updated', // alert → handoff.updated (leva reason)
      'handoff.created', // flag → handoff.created
      'message.status', // message status → 3 salas (agent/editor/admin)
      'message.status',
      'message.status',
      // tipo desconhecido ('wat') → NENHUM emit: só saem os 5 eventos
    ],
  );
  assert.deepEqual(
    emitted.map((e) => e.room),
    // R31: TODA sala embute o tenant — nada sai por sala global.
    [
      'tenant:tenant-x:handoffs',
      'tenant:tenant-x:handoffs',
      'tenant:tenant-x:handoffs',
      'tenant:tenant-x:handoffs',
      'tenant:tenant-x:agent',
      'tenant:tenant-x:editor',
      'tenant:tenant-x:admin',
    ],
  );
  assert.ok(emitted.every((e) => (e.payload as { v: number }).v === 1), 'payload versionado v:1');
  const first = emitted[0]?.payload as Record<string, unknown>;
  assert.equal(first['v'], 1);
  assert.equal(first['outsideHours'], true, 'pass-through dos campos extra (contrato da Fase 3)');
  assert.equal(first['opensAt'], '2026-10-08T08:00:00Z');
  assert.equal('type' in first, false, "'type' não viaja no payload");
  assert.equal('tenantId' in first, false, 'tenantId é metadado de roteamento, não viaja no payload');
});
