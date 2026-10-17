// Onda 1, Task 5 (spec §4.2/§6; rulings R1/R9): os jobs de fundo escopam por
// tenant — o job `inbound.process` resolve a conta (findByProviderSession, SEM
// scope: é resolução de tenant — exceção documentada R1) e propaga o tenant
// resolvido para inbound_events/conversa/mensagem/lead/outbox/orquestrador;
// a idempotência da outbox é única por (tenant_id, idempotency_key).
// Duas contas em DOIS tenants com dados espelhados por inserts directos.
// HMAC reutilizado de tests/helpers/webhook.ts. Fixtures sintéticas — as 20
// conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import { handleInboundEvent } from '../../src/application/handle-inbound.js';
import { createInboundProcessHandler } from '../../src/application/inbound-process.js';
import { advanceMessageStatus } from '../../src/application/message-status.js';
import { handleInbound, type InboundMessage } from '../../src/application/orchestrator.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createUnavailableAiProvider } from '../../src/adapters/ai/unavailable.js';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
import * as k from '../../src/modules/knowledge/knowledge.schema.js';
import type { JobContext, JobQueue } from '../../src/ports/job-queue.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { signWebhook } from '../helpers/webhook.js';

const SECRET = 's'.repeat(32);
const realCfg = {
  baseUrl: 'http://wa.test',
  apiKey: 'chave-teste',
  webhookSecret: SECRET,
  sendTimeoutMs: 15_000,
  cbThreshold: 5,
  cbCooldownMs: 30_000,
};
const PHONE_A = '+2449235550001';
const PHONE_B = '+2449235550002';

/** Tenant B criado por insert directo (os fixtures do helper só têm o MilVendas). */
async function createTenantB(db: DbClient): Promise<string> {
  const id = randomUUID();
  await db.insert(base.tenants).values({ id, name: 'Empresa B (sintética)', status: 'active' });
  return id;
}

/** Captura de message.received com a forma REAL do fork (docs/wa-akg-audit.md §B). */
function receivedPayload(input: { sessionId: string; phone: string; wamid: string; text: string }) {
  const jid = `${input.phone.slice(1)}@s.whatsapp.net`;
  return {
    event: 'message.received',
    sessionId: input.sessionId,
    timestamp: '2026-10-16T09:30:00.000Z',
    data: {
      key: { id: input.wamid, remoteJid: jid, fromMe: false, participant: null },
      pushName: 'Cliente',
      messageTimestamp: 1760511000,
      from: jid,
      receiver: '244990000111@s.whatsapp.net',
      sender: jid,
      isGroup: false,
      chatType: 'PERSONAL',
      type: 'TEXT',
      content: input.text,
      fileUrl: null,
      caption: null,
      quoted: null,
    },
  };
}

/** Fila capturadora: os testes inspecionam os jobs sem os executar. */
interface FakeJobs extends JobQueue {
  enqueued(name: string): Array<{ name: string; payload: Record<string, unknown> }>;
}

function createFakeJobs(): FakeJobs {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  return {
    enqueue: async (name, payload) => {
      calls.push({ name, payload });
    },
    register: async () => {},
    registerRecurring: async () => {},
    close: async () => {},
    enqueued: (name) => calls.filter((c) => c.name === name),
  };
}

/** Conta + contacto + conversa ai_active espelhados para um tenant. */
async function seedTenantData(
  app: TestApp,
  tenantId: string,
  input: { session: string; phone: string },
): Promise<{ accId: string; contactId: string; conversationId: string }> {
  const { id: accId } = await app.accounts.create(
    { tenantId },
    { label: `T5-${input.session}`, purpose: 'support', providerSessionId: input.session, now: new Date() },
  );
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId, phoneE164: input.phone })
    .returning({ id: base.contacts.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId, accountId: accId, contactId: contact!.id, aiMode: 'ai_active' })
    .returning({ id: base.conversations.id });
  return { accId, contactId: contact!.id, conversationId: conv!.id };
}

/** Contagem de linhas de negócio por tenant (espelho directo da matriz de isolamento). */
async function byTenant(db: DbClient, tenantId: string) {
  const count = async (table: { tenantId: string }): Promise<number> =>
    (await db.select({ id: table.tenantId }).from(table).where(eq(table.tenantId, tenantId))).length;
  return {
    contacts: await count(base.contacts),
    conversations: await count(base.conversations),
    leads: await count(base.leads),
    messages: await count(base.messages),
    outbox: await count(base.outboxMessages),
    handoffs: await count(k.handoffs),
    traces: await count(k.answerTraces),
  };
}

/** Pipeline REAL do main.ts (Task 5: seams com o tenant resolvido). */
function makePipeline(app: TestApp) {
  const notifySink = async (e: NotifyEvent): Promise<void> => {
    app.notifyLog.push(e);
  };
  const now = (): Date => new Date();
  const ports = createOrchestratorPorts({ db: app.db, notifySink, claimTtlMs: 30_000, now });
  const outbox = createOutbox({
    db: app.db,
    notifySink,
    now,
    random: Math.random,
    replyDelay: { min: 1000, max: 5000 },
  });
  const orchestrate = (msg: InboundMessage, tenantId: string) =>
    handleInbound(ports.forTenant(tenantId), createUnavailableAiProvider(), msg);
  const runHandleInbound = (eventId: string) =>
    handleInboundEvent(
      {
        db: app.db,
        releaseClaim: ports.releaseClaim,
        orchestrate,
        outbox,
        notifySink,
        cfg: { claimTtlMs: 30_000 },
        now,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
      eventId,
    );
  const lifecycle = createAccountLifecycle({
    accounts: app.accounts,
    provider: app.waProvider,
    notifySink,
    audit: createAuditAdapter({ db: app.db }),
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
  });
  return createInboundProcessHandler({
    db: app.db,
    now,
    logger: { warn: () => {} },
    runHandleInbound,
    advanceStatus: (input) => advanceMessageStatus({ db: app.db, notifySink, now }, input),
    lifecycle,
  });
}

const ctx: JobContext = { correlationId: 'c-t5', jobId: 'job-t5', attempt: 0 };

test('mensagem inbound da conta A cria conversa/mensagem/outbox no tenant A e preenche inbound_events.tenant_id', async () => {
  const jobs = createFakeJobs();
  const app = await buildTestApp({ waProvider: createWaAkgAdapter(realCfg), jobs });
  try {
    const tenantB = await createTenantB(app.db);
    await seedTenantData(app, base.MILVENDAS_TENANT_ID, { session: 'sess-t5-a', phone: PHONE_A });
    await seedTenantData(app, tenantB, { session: 'sess-t5-b', phone: PHONE_B });
    const handler = makePipeline(app);

    const runWebhook = async (payload: ReturnType<typeof receivedPayload>): Promise<string> => {
      const raw = Buffer.from(JSON.stringify(payload));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/wa-akg',
        headers: signWebhook(raw, SECRET),
        payload: raw,
      });
      assert.equal(res.statusCode, 202);
      const job = jobs.enqueued('inbound.process').at(-1);
      assert.ok(job, 'webhook enfileira inbound.process');
      await handler(job.payload, ctx);
      return String(job.payload.eventId);
    };

    // Conta A (MilVendas): tudo o que o job cria pertence ao tenant A.
    const evA = await runWebhook(
      receivedPayload({ sessionId: 'sess-t5-a', phone: PHONE_A, wamid: 'wamid.T5A', text: 'olá da conta A' }),
    );
    const [eventA] = await app.db
      .select({ tenantId: base.inboundEvents.tenantId })
      .from(base.inboundEvents)
      .where(eq(base.inboundEvents.id, evA));
    assert.equal(eventA?.tenantId, base.MILVENDAS_TENANT_ID, 'inbound_events.tenant_id preenchido no job');
    // ai_active + IA indisponível → failSafe: 1 inbound + 1 reply na outbox + handoff + trace
    assert.deepEqual(await byTenant(app.db, base.MILVENDAS_TENANT_ID), {
      contacts: 1,
      conversations: 1,
      leads: 1,
      messages: 2,
      outbox: 1,
      handoffs: 1,
      traces: 1,
    });
    const [outboxA] = await app.db
      .select({ tenantId: base.outboxMessages.tenantId, key: base.outboxMessages.idempotencyKey })
      .from(base.outboxMessages);
    assert.equal(outboxA?.tenantId, base.MILVENDAS_TENANT_ID, 'resposta da IA herda o tenant da conta resolvida');
    assert.equal(outboxA?.key, `inbound:${evA}`, 'chave de idempotência da resposta inbound');

    // Conta B (outro tenant): o mesmo pipeline espelha SÓ linhas do tenant B.
    const evB = await runWebhook(
      receivedPayload({ sessionId: 'sess-t5-b', phone: PHONE_B, wamid: 'wamid.T5B', text: 'olá da conta B' }),
    );
    const [eventB] = await app.db
      .select({ tenantId: base.inboundEvents.tenantId })
      .from(base.inboundEvents)
      .where(eq(base.inboundEvents.id, evB));
    assert.equal(eventB?.tenantId, tenantB, 'evento da conta B pertence ao tenant B');
    assert.deepEqual(await byTenant(app.db, tenantB), {
      contacts: 1,
      conversations: 1,
      leads: 1,
      messages: 2,
      outbox: 1,
      handoffs: 1,
      traces: 1,
    });
    // Nada fugiu para o outro tenant: os totais são o dobro do espelho, sem linha órfã.
    const totals = {
      contacts: (await app.db.select({ id: base.contacts.id }).from(base.contacts)).length,
      messages: (await app.db.select({ id: base.messages.id }).from(base.messages)).length,
      outbox: (await app.db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length,
      handoffs: (await app.db.select({ id: k.handoffs.id }).from(k.handoffs)).length,
    };
    assert.deepEqual(totals, { contacts: 2, messages: 4, outbox: 2, handoffs: 2 });
  } finally {
    await app.close();
  }
});

test('idempotency-key repetida em tenants diferentes → dois envios (unique composto)', async () => {
  const app = await buildTestApp();
  try {
    const tenantB = await createTenantB(app.db);
    const a = await seedTenantData(app, base.MILVENDAS_TENANT_ID, { session: 'sess-t5-2a', phone: PHONE_A });
    const b = await seedTenantData(app, tenantB, { session: 'sess-t5-2b', phone: PHONE_B });
    const outbox = createOutbox({
      db: app.db,
      notifySink: async () => {},
      now: () => new Date(),
      random: () => 0,
      replyDelay: { min: 1000, max: 5000 },
    });
    const input = (fx: { accId: string; contactId: string; conversationId: string }) => ({
      accountId: fx.accId,
      contactId: fx.contactId,
      conversationId: fx.conversationId,
      sender: 'human' as const,
      text: 'olá',
      idempotencyKey: 'dup-composta',
    });

    const first = await outbox.enqueue(input(a));
    const second = await outbox.enqueue(input(b));
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false, 'a MESMA chave noutro tenant NÃO é duplicado (unique composto)');
    assert.notEqual(second.outboxId, first.outboxId, 'dois envios distintos');
    const rows = await app.db
      .select({ tenantId: base.outboxMessages.tenantId })
      .from(base.outboxMessages)
      .where(eq(base.outboxMessages.idempotencyKey, 'dup-composta'))
      .orderBy(base.outboxMessages.tenantId);
    assert.deepEqual(
      rows.map((r) => r.tenantId).sort(),
      [base.MILVENDAS_TENANT_ID, tenantB].sort(),
      'as duas linhas coexistem, cada uma no seu tenant',
    );
  } finally {
    await app.close();
  }
});

test('idempotency-key repetida no mesmo tenant → dedupe como hoje', async () => {
  const app = await buildTestApp();
  try {
    const a1 = await seedTenantData(app, base.MILVENDAS_TENANT_ID, { session: 'sess-t5-3a', phone: PHONE_A });
    // segunda conversa do MESMO tenant, com outro contacto (unique (conta, contacto))
    const [contact2] = await app.db
      .insert(base.contacts)
      .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+2449235550003' })
      .returning({ id: base.contacts.id });
    const [conv2] = await app.db
      .insert(base.conversations)
      .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: a1.accId, contactId: contact2!.id })
      .returning({ id: base.conversations.id });
    const outbox = createOutbox({
      db: app.db,
      notifySink: async () => {},
      now: () => new Date(),
      random: () => 0,
      replyDelay: { min: 1000, max: 5000 },
    });
    const first = await outbox.enqueue({
      accountId: a1.accId,
      contactId: a1.contactId,
      conversationId: a1.conversationId,
      sender: 'human',
      text: 'olá',
      idempotencyKey: 'dup-mesmo-tenant',
    });
    const again = await outbox.enqueue({
      accountId: a1.accId,
      contactId: contact2!.id,
      conversationId: conv2!.id,
      sender: 'human',
      text: 'olá de novo',
      idempotencyKey: 'dup-mesmo-tenant',
    });
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true, 'mesma chave no mesmo tenant continua a deduplicar');
    assert.equal(again.outboxId, first.outboxId, 'devolve a linha vencedora');
    assert.equal(
      (await app.db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length,
      1,
      'sem 2.ª linha na outbox',
    );
  } finally {
    await app.close();
  }
});

test('SQL do orquestrador não escreve nem lê linhas de outro tenant (busca por line_id devolve só as do tenant)', async () => {
  const app = await buildTestApp();
  try {
    const tenantB = await createTenantB(app.db);
    const line = (
      await app.db
        .insert(k.businessLines)
        .values({ slug: 'software', name: 'Software', conversionGoal: 'demo_request' })
        .returning({ id: k.businessLines.id })
    )[0]!;
    const owner = '00000000-0000-4000-8000-000000000001';
    // Conhecimento espelhado nos dois tenants (mesma linha, nomes distintos).
    const seedKnowledge = async (tenantId: string, tag: string): Promise<void> => {
      await app.db.insert(k.rules).values({
        tenantId,
        lineId: line.id,
        kind: 'tone',
        title: `Tom ${tag}`,
        instruction: 'Tratar por Você.',
        status: 'published',
        ownerId: owner,
      });
      await app.db.insert(k.qualificationQuestions).values({
        tenantId,
        lineId: line.id,
        key: `empresa_${tag}`,
        question: 'Como se chama a sua empresa?',
        active: true,
      });
      await app.db.insert(k.handoffTriggers).values({
        tenantId,
        lineId: line.id,
        code: `PRICE_NEGOTIATION_${tag}`,
        description: 'Negociação de preço',
        detectionHint: 'pedir desconto',
        action: 'handoff_now',
        priority: 'normal',
        active: true,
      });
      await app.db.insert(k.catalogItems).values({
        tenantId,
        lineId: line.id,
        kind: 'service',
        name: `CRM ${tag}`,
        slug: `crm-${tag}`,
        summary: 'CRM personalizado',
        pricingMode: 'quote_only',
        status: 'published',
        ownerId: owner,
      });
    };
    await seedKnowledge(base.MILVENDAS_TENANT_ID, 'A');
    await seedKnowledge(tenantB, 'B');
    const convA = await seedTenantData(app, base.MILVENDAS_TENANT_ID, { session: 'sess-t5-4a', phone: PHONE_A });
    const convB = await seedTenantData(app, tenantB, { session: 'sess-t5-4b', phone: PHONE_B });

    const factory = createOrchestratorPorts({
      db: app.db,
      notifySink: async () => {},
      claimTtlMs: 60_000,
      now: () => new Date(),
    });
    const portsA = factory.forTenant(base.MILVENDAS_TENANT_ID);

    // Leituras por line_id devolvem SÓ as linhas do tenant A.
    assert.deepEqual((await portsA.rules('software')).map((r) => r.title), ['Tom A']);
    assert.deepEqual((await portsA.questions('software')).map((q) => q.key), ['empresa_A']);
    assert.deepEqual((await portsA.triggers('software')).map((t) => t.code), ['PRICE_NEGOTIATION_A']);
    assert.deepEqual((await portsA.lookupCatalog('crm', 'software')).map((f) => f.name), ['CRM A']);

    // A conversa do tenant B é invisível: leitura falha e escrita é no-op.
    await assert.rejects(() => portsA.loadState(convB.conversationId), /conversa não encontrada/);
    await portsA.saveState(convB.conversationId, { aiMode: 'human_only' });
    const [convBRow] = await app.db
      .select({ aiMode: base.conversations.aiMode })
      .from(base.conversations)
      .where(eq(base.conversations.id, convB.conversationId));
    assert.equal(convBRow?.aiMode, 'ai_active', 'saveState cross-tenant não escreve (continua o fixture)');
    assert.equal(await portsA.findOpenHandoff(convB.conversationId), null, 'handoffs do outro tenant são invisíveis');

    // Claim: o evento do tenant B não é reivindicável pelos ports do tenant A.
    const mkEvent = async (tenantId: string, suffix: string): Promise<string> => {
      const [row] = await app.db
        .insert(base.inboundEvents)
        .values({ providerEventId: `pe-t5-${suffix}`, payload: { synth: true } })
        .returning({ id: base.inboundEvents.id });
      await app.db
        .update(base.inboundEvents)
        .set({ tenantId })
        .where(eq(base.inboundEvents.id, row!.id));
      return row!.id;
    };
    const evB = await mkEvent(tenantB, 'b');
    const evA = await mkEvent(base.MILVENDAS_TENANT_ID, 'a');
    assert.equal(await portsA.claimMessage(evB), false, 'claim cross-tenant recusado');
    assert.equal(await portsA.claimMessage(evA), true, 'claim do próprio tenant aceite');

    // Escrita: o handoff criado pelos ports do tenant A pertence ao tenant A.
    const handoffId = await portsA.createHandoff({
      conversationId: convA.conversationId,
      triggerId: null,
      reason: 'pedido de humano',
      summary: 'Cliente pediu atendimento.',
      leadSnapshot: {},
      priority: 'normal',
    });
    const [handoffRow] = await app.db
      .select({ tenantId: k.handoffs.tenantId })
      .from(k.handoffs)
      .where(eq(k.handoffs.id, handoffId));
    assert.equal(handoffRow?.tenantId, base.MILVENDAS_TENANT_ID, 'createHandoff escreve no tenant resolvido');
  } finally {
    await app.close();
  }
});
