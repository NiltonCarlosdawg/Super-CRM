// Webhook + job de processamento (Task 20; docs/04 §5, docs/05 §3.1):
// 1. rota pública assinada → resposta 202 ANTES do processamento (o pipeline
//    inteiro corre no job `inbound.process`), ingest idempotente por
//    provider_event_id (mesmo evento 2× → 1 linha, 1 job);
// 2. job: `message.status` avança o estado (docs/04 §8, só avança) + notifica;
// 3. job: `session.status` atualiza a conta (docs/04 §6) + notifica; payload
//    de job inválido é rejeitado sem processar.
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import {
  createInboundProcessHandler,
  type InboundProcessDeps,
} from '../../src/application/inbound-process.js';
import { advanceMessageStatus } from '../../src/application/message-status.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
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

/** Captura de message.received com a forma REAL do fork (docs/wa-akg-audit.md §B). */
const receivedPayload = {
  event: 'message.received',
  sessionId: 'sess-t20',
  timestamp: '2026-10-15T09:30:00.000Z',
  data: {
    key: { id: 'wamid.EVT20', remoteJid: '244923111222@s.whatsapp.net', fromMe: false, participant: null },
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

async function countEvents(db: DbClient): Promise<number> {
  const rows = await db.select({ id: base.inboundEvents.id }).from(base.inboundEvents);
  return rows.length;
}

let evCounter = 0;
async function insertEvent(
  app: TestApp,
  make: (providerEventId: string) => Record<string, unknown>,
): Promise<string> {
  evCounter += 1;
  const providerEventId = `pe-t20-${evCounter}`;
  const [row] = await app.db
    .insert(base.inboundEvents)
    .values({ providerEventId, payload: make(providerEventId) })
    .returning({ id: base.inboundEvents.id });
  if (row === undefined) throw new Error('falhou inserir evento');
  return row.id;
}

function makeHandlerDeps(app: TestApp): InboundProcessDeps {
  const notifySink = async (e: NotifyEvent): Promise<void> => {
    app.notifyLog.push(e);
  };
  return {
    db: app.db,
    now: () => new Date(),
    logger: { warn: () => {} },
    runHandleInbound: async () => {
      throw new Error('runHandleInbound não usado nestes testes');
    },
    advanceStatus: (input) =>
      advanceMessageStatus({ db: app.db, notifySink, now: () => new Date() }, input),
    lifecycle: createAccountLifecycle({
      accounts: app.accounts,
      provider: app.waProvider,
      notifySink,
      audit: createAuditAdapter({ db: app.db }),
      cfg: { failWindow: 20, failRatio: 0.3 },
      now: () => new Date(),
    }),
  };
}

const ctx: JobContext = { correlationId: 'c-t20', jobId: 'job-t20', attempt: 0 };

test('assinatura inválida → 401 sem linha; mesmo evento 2× → 1 linha, 1 job, resposta antes do processamento', async () => {
  const jobs = createFakeJobs();
  const app = await buildTestApp({ waProvider: createWaAkgAdapter(realCfg), jobs });
  try {
    const raw = Buffer.from(JSON.stringify(receivedPayload));

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/wa-akg',
      headers: { ...signWebhook(raw, 'y'.repeat(32)), 'content-type': 'application/json' },
      payload: raw,
    });
    assert.equal(bad.statusCode, 401, 'assinatura errada → 401 problem+json');
    assert.equal(await countEvents(app.db), 0, 'sem linha sem assinatura válida');
    assert.equal(jobs.enqueued('inbound.process').length, 0);

    const headers = signWebhook(raw, SECRET);
    const t0 = process.hrtime.bigint();
    const first = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers, payload: raw });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.ok(ms < 500, `2 pedidos em ${ms.toFixed(1)}ms — resposta sem correr o job`);
    assert.deepEqual(JSON.parse(first.body), { received: true, events: 1 });
    assert.deepEqual(JSON.parse(second.body), { received: true, events: 0 });
    assert.equal(await countEvents(app.db), 1, 'provider_event_id único deduplica');
    assert.equal(jobs.enqueued('inbound.process').length, 1, '1 job por evento, não 2');
    const jobPayload = jobs.enqueued('inbound.process')[0]?.payload as
      | { eventId: string; correlationId: string }
      | undefined;
    const [row] = await app.db
      .select({ id: base.inboundEvents.id })
      .from(base.inboundEvents)
      .limit(1);
    assert.equal(jobPayload?.eventId, row?.id, 'o job leva o id da linha guardada');
    assert.ok(jobPayload?.correlationId.startsWith('webhook:'), 'correlationId derivado do evento');
  } finally {
    await app.close();
  }
});

test('job: message.status avança o estado (só avança) e notifica message.status', async () => {
  const app = await buildTestApp();
  try {
    const { id: accId } = await app.accounts.create({
      label: 'T20-msg',
      purpose: 'support',
      providerSessionId: 'sess-t20-msg',
      now: new Date(),
    });
    const [contact] = await app.db
      .insert(base.contacts)
      .values({ phoneE164: '+2449237770001' })
      .returning({ id: base.contacts.id });
    const [conv] = await app.db
      .insert(base.conversations)
      .values({ accountId: accId, contactId: contact!.id })
      .returning({ id: base.conversations.id });
    await app.db.insert(base.messages).values({
      conversationId: conv!.id,
      accountId: accId,
      direction: 'outbound',
      sender: 'ai',
      body: 'olá',
      providerMessageId: 'pm-t20-out-1',
      status: 'sent',
    });

    const handler = createInboundProcessHandler(makeHandlerDeps(app));
    const evId = await insertEvent(app, (id) => ({
      type: 'message.status',
      providerEventId: id,
      sessionId: 'sess-t20-msg',
      providerMessageId: 'pm-t20-out-1',
      status: 'delivered',
      timestamp: new Date().toISOString(),
    }));
    await handler({ eventId: evId, correlationId: 'c1' }, ctx);
    const [msg] = await app.db
      .select({ status: base.messages.status })
      .from(base.messages)
      .where(eq(base.messages.providerMessageId, 'pm-t20-out-1'));
    assert.equal(msg!.status, 'delivered');
    assert.ok(
      app.notifyLog.some((e) => e.type === 'message' && e.phase === 'status' && e.status === 'delivered'),
      'evento message.status notificado',
    );

    // evento atrasado 'sent' → não regride (docs/04 §8)
    const evId2 = await insertEvent(app, (id) => ({
      type: 'message.status',
      providerEventId: id,
      sessionId: 'sess-t20-msg',
      providerMessageId: 'pm-t20-out-1',
      status: 'sent',
      timestamp: new Date().toISOString(),
    }));
    await handler({ eventId: evId2, correlationId: 'c2' }, ctx);
    const [after] = await app.db
      .select({ status: base.messages.status })
      .from(base.messages)
      .where(eq(base.messages.providerMessageId, 'pm-t20-out-1'));
    assert.equal(after!.status, 'delivered', 'evento atrasado é no-op');

    // reprocessar o MESMO evento → no-op (processed_at)
    const notifyCount = app.notifyLog.length;
    await handler({ eventId: evId, correlationId: 'c1' }, ctx);
    assert.equal(app.notifyLog.length, notifyCount, 'sem efeitos repetidos');
  } finally {
    await app.close();
  }
});

test('job: session.status atualiza a conta e notifica; payload inválido rejeita sem processar', async () => {
  const app = await buildTestApp();
  try {
    const { id: accId } = await app.accounts.create({
      label: 'T20-sess',
      purpose: 'support',
      providerSessionId: 'sess-t20-sess',
      now: new Date(),
    });
    const handler = createInboundProcessHandler(makeHandlerDeps(app));
    const evId = await insertEvent(app, (id) => ({
      type: 'session.status',
      providerEventId: id,
      sessionId: 'sess-t20-sess',
      status: 'connected',
      // eventos de sessão normalizados NÃO têm timestamp (contrato do port)
    }));
    await handler({ eventId: evId, correlationId: 'c1' }, ctx);
    const acc = await app.accounts.get(accId);
    assert.equal(acc!.status, 'connected');
    assert.ok(
      app.notifyLog.some((e) => e.type === 'account' && e.status === 'connected'),
      'evento account.status notificado',
    );
    // evento já processado → idempotente
    await handler({ eventId: evId, correlationId: 'c1' }, ctx);

    await assert.rejects(() => handler({}, ctx), /payload inválido/, 'payload vazio rejeitado');
  } finally {
    await app.close();
  }
});
