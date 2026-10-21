// Fase 3, Task 14: fila de handoffs com claim, resolução e devolução à IA
// (ADR-0003 A6.1, A10). Integração com Postgres real:
// 1. claim concorrente — o comutador atómico deixa EXATAMENTE UM vencer;
// 2. SLA de primeira resposta excedido emite o alerta + audit;
// 3. resolve devolve ao ai_mode por defeito e audita os dois passos;
// 4. botão manual devolve à IA com o handoff ainda pendente;
// 5. API — sem sessão 401, agent 200, claim perdido 409;
// 6. GET /v1/handoffs/:id devolve summary, leadSnapshot e prioridade.
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import * as base from '../../src/adapters/db/schema/index.js';
import { handoffs } from '../../src/modules/knowledge/knowledge.schema.js';
import {
  acceptHandoff,
  resolveHandoff,
  returnConversationToAi,
} from '../../src/application/handoffs.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

/** Ações de handoff/auditoria deste módulo (os `auth.login` do setup ficam de fora). */
const HANDOFF_AUDITS = [
  'handoff.accepted',
  'handoff.resolved',
  'conversation.returned_to_ai',
  'handoff.sla_breach',
];

async function mkConv(app: TestApp): Promise<string> {
  const { id: accId } = await app.accounts.create(
    { tenantId: base.MILVENDAS_TENANT_ID },
    { label: 'T14', purpose: 'support', providerSessionId: 'sess-t14', now: new Date() },
  );
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923777333' })
    .returning({ id: base.contacts.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: accId, contactId: contact!.id, aiMode: 'ai_active' })
    .returning({ id: base.conversations.id });
  if (contact === undefined || conv === undefined) throw new Error('fixture T14 falhou');
  return conv.id;
}

async function mkHandoff(
  app: TestApp,
  cid: string,
  opts: { createdAt?: Date; priority?: 'urgent' | 'high' | 'normal' } = {},
): Promise<string> {
  const [h] = await app.db
    .insert(handoffs)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      conversationId: cid,
      reason: 'Cliente pediu falar com humano',
      summary: 'Resumo sintético da conversa.',
      leadSnapshot: { canal: 'whatsapp' },
      priority: opts.priority ?? 'urgent',
      status: 'pending',
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: handoffs.id });
  if (h === undefined) throw new Error('fixture handoff falhou');
  return h.id;
}

async function aiMode(app: TestApp, cid: string): Promise<string> {
  const [row] = await app.db
    .select({ aiMode: base.conversations.aiMode })
    .from(base.conversations)
    .where(eq(base.conversations.id, cid));
  return row!.aiMode;
}

async function audits(app: TestApp): Promise<Array<{ action: string }>> {
  return app.db
    .select({ action: base.auditLog.action })
    .from(base.auditLog)
    .where(inArray(base.auditLog.action, HANDOFF_AUDITS))
    .orderBy(base.auditLog.createdAt);
}

test('claim concorrente: exatamente um vence', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    const hid = await mkHandoff(app, cid);
    const d1 = app.mkHandoffDeps(base.MILVENDAS_TENANT_ID);
    const d2 = app.mkHandoffDeps(base.MILVENDAS_TENANT_ID);
    const u1 = app.users.agent.id;
    const u2 = app.users.admin.id;

    const r = await Promise.all([acceptHandoff(d1, hid, u1), acceptHandoff(d2, hid, u2)]);
    assert.deepEqual([...r].sort(), ['claimed', 'taken']);

    const [row] = await app.db
      .select({ status: handoffs.status, acceptedBy: handoffs.acceptedById })
      .from(handoffs)
      .where(eq(handoffs.id, hid));
    assert.equal(row!.status, 'accepted');
    assert.ok([u1, u2].includes(row!.acceptedBy!), 'aceite por um dos dois');
    assert.equal(await aiMode(app, cid), 'human_only');
    assert.equal((await audits(app)).filter((a) => a.action === 'handoff.accepted').length, 1);
  } finally {
    await app.close();
  }
});

test('aceitar com SLA de 2 h excedido emite o alerta', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    // 3 h úteis antes: quarta 12:00 Luanda (11:00Z) → now quarta 15:00 Luanda (14:00Z).
    const hid = await mkHandoff(app, cid, { createdAt: new Date('2026-10-07T11:00:00Z') });
    const deps = app.mkHandoffDeps(base.MILVENDAS_TENANT_ID, () => new Date('2026-10-07T14:00:00Z'));

    assert.equal(await acceptHandoff(deps, hid, app.users.agent.id), 'claimed');

    const alerts = app.handoffNotifyLog.filter((e) => e.type === 'alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.reason, 'sla_first_response_2h');
    assert.ok((await audits(app)).some((a) => a.action === 'handoff.sla_breach'));
  } finally {
    await app.close();
  }
});

test('resolve devolve ao ai_mode por defeito e audita os dois passos', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    const hid = await mkHandoff(app, cid, { createdAt: new Date('2026-10-07T09:00:00Z') });
    // Relógio a avançar 1 s por chamada → createdAt dos audits determinístico.
    let t = Date.parse('2026-10-07T10:00:00Z');
    const deps = app.mkHandoffDeps(base.MILVENDAS_TENANT_ID, () => new Date((t += 1000)));

    assert.equal(await acceptHandoff(deps, hid, app.users.agent.id), 'claimed');
    assert.equal(await resolveHandoff(deps, hid, app.users.agent.id), 'resolved');

    assert.equal(await aiMode(app, cid), 'ai_suggest'); // DEFAULT_SETTINGS.aiModeDefault.global
    assert.deepEqual((await audits(app)).map((a) => a.action), [
      'handoff.accepted',
      'handoff.resolved',
      'conversation.returned_to_ai',
    ]);
  } finally {
    await app.close();
  }
});

test('botão manual devolve à IA com handoff ainda pendente', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    await mkHandoff(app, cid); // fica pendente (nunca aceite)
    const deps = app.mkHandoffDeps(base.MILVENDAS_TENANT_ID);

    assert.deepEqual(await returnConversationToAi(deps, cid, app.users.agent.id), { aiMode: 'ai_suggest' });
    assert.equal((await audits(app)).at(-1)!.action, 'conversation.returned_to_ai');
  } finally {
    await app.close();
  }
});

test('API: sem sessão 401, papel agent 200, claim perdido 409', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    const hid = await mkHandoff(app, cid);

    const anon = await app.inject({ method: 'POST', url: `/v1/handoffs/${hid}/accept` });
    assert.equal(anon.statusCode, 401);

    const ok = await app.inject({
      method: 'POST',
      url: `/v1/handoffs/${hid}/accept`,
      cookies: { session: app.sessions.agent, csrf: app.csrf.agent },
      headers: { 'x-csrf-token': app.csrf.agent },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, 'claimed');

    const taken = await app.inject({
      method: 'POST',
      url: `/v1/handoffs/${hid}/accept`,
      cookies: { session: app.sessions.admin, csrf: app.csrf.admin },
      headers: { 'x-csrf-token': app.csrf.admin },
    });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().title, 'handoff_taken');
  } finally {
    await app.close();
  }
});

test('GET /v1/handoffs/:id devolve summary, leadSnapshot e prioridade', async () => {
  const app = await buildTestApp();
  try {
    const cid = await mkConv(app);
    const hid = await mkHandoff(app, cid, { priority: 'high' });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/handoffs/${hid}`,
      cookies: { session: app.sessions.agent },
    });
    assert.equal(res.statusCode, 200);
    const h = res.json().handoff as Record<string, unknown>;
    assert.equal(h.id, hid);
    assert.equal(h.summary, 'Resumo sintético da conversa.');
    assert.deepEqual(h.leadSnapshot, { canal: 'whatsapp' });
    assert.equal(h.priority, 'high');
    assert.equal(h.status, 'pending');
  } finally {
    await app.close();
  }
});
