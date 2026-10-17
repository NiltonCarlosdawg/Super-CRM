// Fluxo ponta-a-ponta (Task 22; docs/01 §5, docs/04 §7, docs/05 §3.1):
// 1. entrada: webhook assinado → 202 rápido → job `inbound.process` → failSafe
//    (sem IA real) → handoff + reply 'ai' na outbox → worker envia UMA vez;
//    re-POST do mesmo evento → sem 2.º job e sem efeitos novos;
// 2. saída: 2 envios humanos → 0 chamadas ao provider antes do worker; depois
//    message.created ×2 + message.status ×2, concorrência máx. = 1;
// 3. sem sessão → 401 com zero efeitos.
// Só testes: o código de produção só se um teste destoar (nunca o contrário).
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createUnavailableAiProvider } from '../../src/adapters/ai/unavailable.js';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import { handleInboundEvent } from '../../src/application/handle-inbound.js';
import { createInboundProcessHandler } from '../../src/application/inbound-process.js';
import { advanceMessageStatus } from '../../src/application/message-status.js';
import { handleInbound, type InboundMessage } from '../../src/application/orchestrator.js';
import { runOutboxTick } from '../../src/application/outbox-worker.js';
import { handoffs } from '../../src/modules/knowledge/knowledge.schema.js';
import type { JobContext, JobQueue } from '../../src/ports/job-queue.js';
import type { MessagingProvider } from '../../src/ports/messaging-provider.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { createFakeMessaging } from '../helpers/fake-messaging.js';
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
const SESSION_ID = 'sess-t22';
const PHONE = '+244923111222';

/** Captura de message.received com a forma REAL do fork (docs/wa-akg-audit.md §B). */
const receivedPayload = {
  event: 'message.received',
  sessionId: SESSION_ID,
  timestamp: '2026-10-15T09:30:00.000Z',
  data: {
    key: { id: 'wamid.EVT22', remoteJid: '244923111222@s.whatsapp.net', fromMe: false, participant: null },
    pushName: 'Maria',
    messageTimestamp: 1760511000,
    from: '244923111222@s.whatsapp.net',
    receiver: '244990000111@s.whatsapp.net',
    sender: '244923111222@s.whatsapp.net',
    isGroup: false,
    chatType: 'PERSONAL',
    type: 'TEXT',
    content: 'olá do cliente',
    fileUrl: null,
    caption: null,
    quoted: null,
  },
};

/** Fila capturadora (padrão Task 20): os testes inspecionam sem executar. */
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

/** Conta ligada à MESMA sessionId do webhook + contacto + conversa sintéticos. */
async function mkConversation(
  app: TestApp,
  opts?: { aiMode?: 'ai_active' | 'ai_suggest' | 'human_only' },
): Promise<{ cid: string }> {
  const { id: accId } = await app.accounts.create(
    { tenantId: base.MILVENDAS_TENANT_ID }, // Task 4: escopo do tenant MilVendas
    {
      label: 'T22',
      purpose: 'support',
      providerSessionId: SESSION_ID,
      now: new Date(),
    },
  );
  await app.accounts.setStatus({ tenantId: base.MILVENDAS_TENANT_ID }, accId, 'connected', new Date());
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: PHONE })
    .returning({ id: base.contacts.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: accId, contactId: contact!.id, aiMode: opts?.aiMode })
    .returning({ id: base.conversations.id });
  if (contact === undefined || conv === undefined) throw new Error('falhou fixture T22');
  return { cid: conv.id };
}

/**
 * Pipeline REAL do main.ts (T19/T20): webhook → job → handleInboundEvent →
 * orquestrador (IA indisponível → failSafe) → outbox → worker. O tick corre com
 * relógio À FRENTE (+10 s) porque as respostas ficam agendadas em
 * [now+1000, now+5000] — sem espera real.
 */
function makePipeline(app: TestApp, provider: MessagingProvider) {
  const notifySink = async (e: NotifyEvent): Promise<void> => {
    app.notifyLog.push(e);
  };
  const now = (): Date => new Date();
  const audit = createAuditAdapter({ db: app.db });
  const ports = createOrchestratorPorts({ db: app.db, notifySink, claimTtlMs: 30_000, now });
  const outbox = createOutbox({
    db: app.db,
    notifySink,
    now,
    random: Math.random,
    replyDelay: { min: 1000, max: 5000 },
  });
  // Onda 1 (Task 5, ruling R1): o tenant vem do seam — o job resolve-o pela
  // conta do webhook e cria os ports do orquestrador DESSE tenant.
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
    provider,
    notifySink,
    audit,
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
  });
  const handler = createInboundProcessHandler({
    db: app.db,
    now,
    logger: { warn: () => {} },
    runHandleInbound,
    advanceStatus: (input) => advanceMessageStatus({ db: app.db, notifySink, now }, input),
    lifecycle,
  });
  const tick = {
    db: app.db,
    provider,
    accounts: lifecycle,
    notifySink,
    audit,
    now: (): Date => new Date(Date.now() + 10_000),
    random: (): number => 0,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    cfg: { sendTimeoutMs: 15_000, maxAttempts: 3, retryDelayMs: 1_000 },
  };
  return { handler, tick };
}

test('entrada: webhook assinado → 202 rápido → job → handoff+reply na outbox → worker envia UMA vez', async () => {
  const jobs = createFakeJobs();
  // O webhook exige o adaptador REAL (assinatura + parse); o worker usa um fake.
  const app = await buildTestApp({ waProvider: createWaAkgAdapter(realCfg), jobs });
  const fm = createFakeMessaging();
  try {
    await mkConversation(app, { aiMode: 'ai_active' });
    const { handler, tick } = makePipeline(app, fm.provider);

    const raw = Buffer.from(JSON.stringify(receivedPayload));
    const t0 = process.hrtime.bigint();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/wa-akg',
      headers: signWebhook(raw, SECRET),
      payload: raw,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.statusCode, 202, '202 com assinatura válida');
    assert.ok(ms < 500, `202 em ${ms.toFixed(1)}ms — resposta antes do processamento`);
    assert.equal(fm.sendTextCalls.length, 0, 'nenhum efeito antes do job');
    assert.equal((await app.db.select({ id: handoffs.id }).from(handoffs)).length, 0);

    const job = jobs.enqueued('inbound.process')[0];
    assert.ok(job, 'exactamente 1 job enfileirado');
    assert.equal(jobs.enqueued('inbound.process').length, 1);
    const ctx: JobContext = {
      correlationId: String(job.payload.correlationId),
      jobId: 'job-t22-1',
      attempt: 0,
    };
    await handler(job.payload, ctx);

    // failSafe do ai_active: handoff + reply com sender 'ai' na outbox
    const hs = await app.db.select({ id: handoffs.id, status: handoffs.status }).from(handoffs);
    assert.equal(hs.length, 1, '1 handoff criado pelo failSafe');
    assert.equal(hs[0]?.status, 'pending');
    const ob = await app.db
      .select({ key: base.outboxMessages.idempotencyKey, messageId: base.outboxMessages.messageId })
      .from(base.outboxMessages);
    assert.equal(ob.length, 1, '1 reply enfileirado (o orquestrador nunca chama send)');
    assert.equal(ob[0]?.key, `inbound:${job.payload.eventId}`, 'idempotência inbound:<eventId>');
    const [replyMsg] = await app.db
      .select({ sender: base.messages.sender, direction: base.messages.direction })
      .from(base.messages)
      .where(eq(base.messages.id, ob[0]!.messageId));
    assert.equal(replyMsg?.sender, 'ai');
    assert.equal(replyMsg?.direction, 'outbound');
    assert.equal(fm.sendTextCalls.length, 0, 'worker ainda não correu');

    // worker: envia UMA vez, para o telefone certo, estado 'sent'
    const tickRes = await runOutboxTick(tick);
    assert.equal(tickRes.sent, 1, '1 envio concluído');
    assert.equal(fm.sendTextCalls.length, 1, 'envio único');
    assert.equal(fm.sendTextCalls[0]?.to, PHONE);
    const [sentRow] = await app.db
      .select({ status: base.messages.status })
      .from(base.messages)
      .where(eq(base.messages.id, ob[0]!.messageId));
    assert.equal(sentRow?.status, 'sent');

    // re-POST do mesmo webhook: dedupe → sem 2.º job; re-execução do job → no-op
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/wa-akg',
      headers: signWebhook(raw, SECRET),
      payload: raw,
    });
    assert.equal(res2.statusCode, 202);
    assert.deepEqual(JSON.parse(res2.body), { received: true, events: 0 }, 'provider_event_id deduplica');
    assert.equal(jobs.enqueued('inbound.process').length, 1, 'sem 2.º job');
    await handler(job.payload, ctx); // retry/reentrega do MESMO job

    const msgRows = await app.db
      .select({ id: base.messages.id, direction: base.messages.direction })
      .from(base.messages);
    assert.equal(msgRows.length, 2, '1 inbound + 1 outbound — nada duplicado');
    assert.equal(
      (await app.db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length,
      1,
      '1 linha de outbox',
    );
    assert.equal(fm.sendTextCalls.length, 1, 'nenhum 2.º envio');
    assert.equal(
      (await app.db.select({ id: handoffs.id }).from(handoffs)).length,
      1,
      'handoff aberto é reutilizado',
    );
  } finally {
    await app.close();
  }
});

test('saída: 2 envios humanos → 0 chamadas antes do worker; depois message.created ×2 + message.status ×2, concorrência máx. = 1', async () => {
  const app = await buildTestApp();
  const fm = createFakeMessaging();
  try {
    const { cid } = await mkConversation(app);
    const post = (key: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/conversations/${cid}/messages`,
        cookies: { session: app.sessions.agent, csrf: app.csrf.agent },
        headers: { 'x-csrf-token': app.csrf.agent, 'idempotency-key': key },
        payload: { text: `olá ${key}` },
      });
    assert.equal((await post('S1')).statusCode, 201);
    assert.equal((await post('S2')).statusCode, 201);

    const created = (): number =>
      app.notifyLog.filter((e) => e.type === 'message' && e.phase === 'created').length;
    const status = (): number =>
      app.notifyLog.filter((e) => e.type === 'message' && e.phase === 'status').length;
    assert.equal(fm.sendTextCalls.length, 0, 'worker ainda não correu — nada fora da outbox');
    assert.equal(created(), 2, 'message.created ×2 (uma por enqueue)');
    assert.equal(status(), 0, 'sem estado de envio antes do worker');

    // espião de concorrência: janela para sobrepor se o worker alguma vez
    // processasse em paralelo — máx. de envios em voo observado. Os ids do
    // provider são ÚNICOS por chamada (como o real; o default constante do
    // fake violaria messages_account_provider_uq no 2.º envio — padrão da T18B).
    let inflight = 0;
    let maxInflight = 0;
    let seq = 0;
    const origSend = fm.provider.sendText.bind(fm.provider);
    fm.provider.sendText = async (input) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        seq += 1;
        const res = await origSend(input); // regista em sendTextCalls
        return { ...res, providerMessageId: `fake-wa-t22-${seq}` };
      } finally {
        inflight -= 1;
      }
    };

    const { tick } = makePipeline(app, fm.provider);
    for (let i = 0; i < 5 && fm.sendTextCalls.length < 2; i++) {
      await runOutboxTick(tick);
    }
    assert.equal(fm.sendTextCalls.length, 2, 'ambos os envios concluídos');
    assert.equal(maxInflight, 1, 'nunca mais de 1 envio em voo (serialização)');
    assert.equal(status(), 2, 'message.status ×2');
    assert.equal(created(), 2, 'sem efeitos extra');
    const msgRows = await app.db.select({ id: base.messages.id }).from(base.messages);
    assert.equal(msgRows.length, 2, '2 mensagens — os replays não duplicam');
  } finally {
    await app.close();
  }
});

test('sem sessão → 401 sem efeitos', async () => {
  const app = await buildTestApp();
  try {
    const { cid } = await mkConversation(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${cid}/messages`,
      headers: { 'idempotency-key': 'NO1' },
      payload: { text: 'oi' },
    });
    assert.equal(res.statusCode, 401, 'sem cookies → CSRF ignorado → 401 da sessão');
    assert.equal(
      (await app.db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length,
      0,
      'zero efeitos: nada enfileirado',
    );
    assert.equal((await app.db.select({ id: base.messages.id }).from(base.messages)).length, 0);
  } finally {
    await app.close();
  }
});
