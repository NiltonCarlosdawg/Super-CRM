// API de conversas e mensagens (Task 21; docs/01 §5, docs/02 §5):
// 1. paginação por cursor keyset opaco — 5 mensagens, limit 2 → 3 páginas sem
//    repetir nem faltar; cursor/limit inválidos → 400;
// 2. envio humano com Idempotency-Key — 400 sem cabeçalho, 201 na 1.ª,
//    200 replayed no replay, 409 com corpo diferente, 400 por texto longo/
//    vazio; SÓ pela outbox (nenhuma chamada direta ao provider);
// 3. RBAC — sessão obrigatória (401); qualquer papel lê; editor envia.
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import * as base from '../../src/adapters/db/schema/index.js';
import { buildTestApp, createFakeWaProvider, type TestApp } from '../helpers/http.js';

/** Conta + contacto + conversa sintéticos (sem mensagens). */
async function mkConversation(app: TestApp): Promise<{ cid: string; accId: string }> {
  const { id: accId } = await app.accounts.create(
    { tenantId: base.MILVENDAS_TENANT_ID }, // Task 4: escopo do tenant MilVendas
    {
      label: 'T21',
      purpose: 'support',
      providerSessionId: 'sess-t21',
      now: new Date(),
    },
  );
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923777111' })
    .returning({ id: base.contacts.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: accId, contactId: contact!.id })
    .returning({ id: base.conversations.id });
  if (contact === undefined || conv === undefined) throw new Error('falhou fixture T21');
  return { cid: conv.id, accId };
}

test('paginação por cursor: 5 mensagens, limit 2 → 3 páginas sem repetir nem faltar', async () => {
  const app = await buildTestApp();
  try {
    const { cid, accId } = await mkConversation(app);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await app.db.insert(base.messages).values({
        tenantId: base.MILVENDAS_TENANT_ID,
        conversationId: cid,
        accountId: accId,
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        sender: i % 2 === 0 ? 'customer' : 'human',
        body: `m${i + 1}`, // m1 é a mais recente (created_at decrescente)
        status: 'sent',
        createdAt: new Date(t0 - i * 60_000),
      });
    }
    const auth = { cookies: { session: app.sessions.agent } };

    const p1 = await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?limit=2`, ...auth });
    assert.equal(p1.statusCode, 200);
    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${cid}/messages?limit=2&cursor=${encodeURIComponent(p1.json().nextCursor)}`,
      ...auth,
    });
    assert.equal(p2.statusCode, 200);
    const p3 = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${cid}/messages?limit=2&cursor=${encodeURIComponent(p2.json().nextCursor)}`,
      ...auth,
    });
    assert.equal(p3.statusCode, 200);

    const msgs = [...p1.json().messages, ...p2.json().messages, ...p3.json().messages] as Array<{
      id: string;
      body: string;
      createdAt: string;
    }>;
    const ids = msgs.map((m) => m.id);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, 'sem repetir');
    assert.equal(p3.json().nextCursor, null, 'última página fecha a paginação');
    // ordem: created_at DESC estável entre páginas (sem faltar nem trocar)
    assert.deepEqual(msgs.map((m) => m.body), ['m1', 'm2', 'm3', 'm4', 'm5']);
    const times = msgs.map((m) => Date.parse(m.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'created_at decrescente');

    const badCursor = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${cid}/messages?cursor=lixo`,
      ...auth,
    });
    assert.equal(badCursor.statusCode, 400, 'cursor inválido → 400');

    const badLimit = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${cid}/messages?limit=101`,
      ...auth,
    });
    assert.equal(badLimit.statusCode, 400, 'limit fora de 1–100 → 400');
  } finally {
    await app.close();
  }
});

test('envio humano: sem Idempotency-Key → 400; 1.ª → 201; replay → 200 replayed; corpo diferente → 409; texto longo → 400', async () => {
  const app = await buildTestApp();
  try {
    const { cid } = await mkConversation(app);
    const provider = app.waProvider as ReturnType<typeof createFakeWaProvider>;
    const post = (key: string | null, text: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/conversations/${cid}/messages`,
        cookies: { session: app.sessions.agent, csrf: app.csrf.agent },
        headers: { 'x-csrf-token': app.csrf.agent, ...(key !== null ? { 'idempotency-key': key } : {}) },
        payload: { text },
      });

    const noKey = await post(null, 'olá');
    assert.equal(noKey.statusCode, 400);
    assert.match(noKey.json().detail, /Idempotency-Key/);

    const t0 = Date.now();
    const first = await post('K1', 'olá');
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().replayed, false);
    assert.equal(
      provider.sendTextCalls.length,
      0,
      'nenhum envio fora da outbox (worker ainda não correu)',
    );

    const replay = await post('K1', 'olá');
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().message.id, first.json().message.id);

    const conflict = await post('K1', 'outro texto');
    assert.equal(conflict.statusCode, 409);

    const tooLong = await post('K2', 'x'.repeat(4097));
    assert.equal(tooLong.statusCode, 400);
    assert.match(tooLong.json().detail, /4096|WA_MAX_MESSAGE_CHARS/);

    const empty = await post('K3', '   ');
    assert.equal(empty.statusCode, 400);

    // efeitos: 1 mensagem + 1 outbox (priority 1, scheduled em [min,max])
    const msgRows = await app.db
      .select({ id: base.messages.id, sender: base.messages.sender })
      .from(base.messages)
      .where(eq(base.messages.conversationId, cid));
    assert.equal(msgRows.length, 1, 'uma única mensagem criada (replays não duplicam)');
    assert.equal(msgRows[0]?.sender, 'human');

    const obRows = await app.db
      .select({
        priority: base.outboxMessages.priority,
        scheduledAt: base.outboxMessages.scheduledAt,
        status: base.outboxMessages.status,
      })
      .from(base.outboxMessages);
    assert.equal(obRows.length, 1, 'uma única linha na outbox');
    assert.equal(obRows[0]?.priority, 1, 'resposta de conversa = prioridade 1');
    assert.equal(obRows[0]?.status, 'queued');
    const scheduled = obRows[0]!.scheduledAt.getTime();
    assert.ok(
      scheduled >= t0 + 1000 && scheduled <= Date.now() + 5000,
      `scheduledAt fora da janela [min=1000, max=5000]: ${new Date(scheduled).toISOString()}`,
    );
    assert.ok(
      app.notifyLog.some((e) => e.type === 'message' && e.phase === 'created'),
      'evento message.created emitido pelo enqueue',
    );
    assert.equal(provider.sendTextCalls.length, 0, 'a outbox é a única saída');
  } finally {
    await app.close();
  }
});

test('RBAC: sem sessão → 401; qualquer papel lê; editor também envia', async () => {
  const app = await buildTestApp();
  try {
    const { cid } = await mkConversation(app);

    // sem sessão: leitura e mutação → 401
    for (const url of ['/v1/conversations', `/v1/conversations/${cid}`, `/v1/conversations/${cid}/messages`]) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, `GET ${url} sem sessão`);
    }
    const postNoSession = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${cid}/messages`,
      payload: { text: 'oi' },
    });
    assert.equal(postNoSession.statusCode, 401, 'POST sem sessão');

    // qualquer papel lê (agent, editor, admin)
    for (const session of [app.sessions.agent, app.sessions.editor, app.sessions.admin]) {
      const list = await app.inject({ method: 'GET', url: '/v1/conversations', cookies: { session } });
      assert.equal(list.statusCode, 200, 'lista legível');
      const detail = await app.inject({ method: 'GET', url: `/v1/conversations/${cid}`, cookies: { session } });
      assert.equal(detail.statusCode, 200, 'detalhe legível');
      const msgs = await app.inject({
        method: 'GET',
        url: `/v1/conversations/${cid}/messages`,
        cookies: { session },
      });
      assert.equal(msgs.statusCode, 200, 'mensagens legíveis');
    }

    // editor também envia (sessão + CSRF)
    const send = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${cid}/messages`,
      cookies: { session: app.sessions.editor, csrf: app.csrf.editor },
      headers: { 'x-csrf-token': app.csrf.editor, 'idempotency-key': 'ED1' },
      payload: { text: 'do editor' },
    });
    assert.equal(send.statusCode, 201);
    assert.equal(send.json().replayed, false);
  } finally {
    await app.close();
  }
});
