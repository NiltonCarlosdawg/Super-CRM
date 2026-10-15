// Fase 1, Task 15: Socket.IO — handshake autenticado por cookie de sessão,
// salas por papel e mapeamento dos 5 eventos do painel (docs/02 §9).
// Cliente socket.io-client real contra o servidor do buildTestApp.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { io as connect, type Socket } from 'socket.io-client';
import { createSocketNotify, type SocketIoLike } from '../../src/adapters/realtime/socket.js';
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

  await notify({ type: 'message', phase: 'created', messageId: 'm1', conversationId: 'c1' });
  await notify({ type: 'handoff', handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r' });
  await notify({ type: 'account', accountId: 'a1', status: 'connected' });

  assert.deepEqual(await got, { v: 1, messageId: 'm1', conversationId: 'c1' });
  assert.deepEqual(await agentHandoff, { v: 1, handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r' });
  assert.equal(await noHandoff, null, 'editor fora da sala handoffs (docs/02 §9)');
  assert.deepEqual(await gotAcct, { v: 1, accountId: 'a1', status: 'connected' });
  assert.equal(await agentNoAcct, null, 'account.status só para admin');

  await closeClients();
  await app.close();
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
    type: 'handoff', handoffId: 'h1', conversationId: 'c1', priority: 'normal', reason: 'r',
    outsideHours: true, opensAt: '2026-10-08T08:00:00Z',
  });
  await notify({ type: 'handoff', phase: 'updated', handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r2' });
  await notify({ type: 'alert', reason: 'opening_pending', handoffId: 'h1' });
  await notify({ type: 'flag', handoffId: 'h2', conversationId: 'c1', priority: 'normal', reason: 'f' });
  await notify({ type: 'message', phase: 'status', messageId: 'm1', status: 'sent' });
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
    ['handoffs', 'handoffs', 'handoffs', 'handoffs', 'agent', 'editor', 'admin'],
  );
  assert.ok(emitted.every((e) => (e.payload as { v: number }).v === 1), 'payload versionado v:1');
  const first = emitted[0]?.payload as Record<string, unknown>;
  assert.equal(first['v'], 1);
  assert.equal(first['outsideHours'], true, 'pass-through dos campos extra (contrato da Fase 3)');
  assert.equal(first['opensAt'], '2026-10-08T08:00:00Z');
  assert.equal('type' in first, false, "'type' não viaja no payload");
});
