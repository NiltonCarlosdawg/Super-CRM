// Fase 3, Task 18: modo ai_suggest ponta-a-ponta (docs/05 §2):
// processInbound cria o rascunho → humano aprova → sai pela outbox → o worker da
// Fase 1 envia UMA vez (idempotência `draft:<draftId>`). Rejeitar não gera outbox.
// API: sessão obrigatória (401), papel agent aprova, aprovar rascunho rejeitado → 409.
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';

import type { AIConfig } from '../../src/adapters/ai/config.js';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createDraftsRepository } from '../../src/adapters/db/drafts.js';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { processInbound, type ProcessInboundDeps } from '../../src/application/process-inbound.js';
import { runOutboxTick } from '../../src/application/outbox-worker.js';
import { listDrafts, approveDraft, rejectDraft, type DraftDeps } from '../../src/modules/drafts/service.js';
import { DEFAULT_SETTINGS } from '../../src/modules/settings/settings.js';
import type { AIProvider, AIResponse, NotifyEvent } from '../../src/ports/ai-provider.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { createFakeMessaging } from '../helpers/fake-messaging.js';

const AI_CFG: AIConfig = {
  provider: 'openai',
  model: 'test-model',
  baseUrl: null,
  apiKey: null,
  timeoutMs: 20_000,
  maxRetries: 0,
  maxTokens: 256,
  historyTurns: 10,
  retrievalTopK: 5,
  retrievalMinSimilarity: 0.75,
  missStreakLimit: 2,
  dataApproved: false,
};

function fakeProvider(over?: Partial<AIProvider>): AIProvider {
  const reply: AIResponse = {
    reply: 'Rascunho de resposta da IA.',
    answered: true,
    firedTriggers: [],
    qualificationUpdates: {},
    sources: [],
    model: 'fake',
  };
  return {
    respond: async () => reply,
    summarizeForHandoff: async () => 'resumo',
    extractKnowledge: async () => ({ items: [] }),
    ...over,
  };
}

interface Ctx {
  app: TestApp;
  piDeps: ProcessInboundDeps;
  draftDeps: DraftDeps;
  convId: string;
  fm: ReturnType<typeof createFakeMessaging>;
  runOutboxWorker: () => Promise<{ claimed: number; sent: number }>;
  /** Insere um evento de webhook e devolve o id (mensagem real → claim aplicado). */
  mkEvent: () => Promise<string>;
}

async function setup(): Promise<Ctx> {
  // buildTestApp reinicia a BD (cria utilizadores/sessões); as fixtures vêm DEPOIS.
  const app = await buildTestApp();

  const { id: accId } = await app.accounts.create(
    { tenantId: base.MILVENDAS_TENANT_ID },
    { label: 'T18', purpose: 'support', providerSessionId: 'sess-t18', now: new Date() },
  );
  await app.accounts.setStatus({ tenantId: base.MILVENDAS_TENANT_ID }, accId, 'connected', new Date());
  const [contact] = await app.db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923333333', name: 'Cliente T18' })
    .returning({ id: base.contacts.id });
  const [conv] = await app.db
    .insert(base.conversations)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: accId, contactId: contact!.id, aiMode: 'ai_suggest' })
    .returning({ id: base.conversations.id });
  if (contact === undefined || conv === undefined) throw new Error('falhou fixture T18');

  const notifySink = async (e: NotifyEvent): Promise<void> => {
    app.notifyLog.push(e);
  };
  const audit = createAuditAdapter({ db: app.db });
  const portsFactory = createOrchestratorPorts({ db: app.db, notifySink, claimTtlMs: 60_000, now: () => new Date() });
  const ports = portsFactory.forTenant(base.MILVENDAS_TENANT_ID);
  const claims = { release: (eventId: string) => portsFactory.releaseClaim(eventId, base.MILVENDAS_TENANT_ID) };
  const outbox = createOutbox({ db: app.db, notifySink, now: () => new Date(), random: () => 0, replyDelay: { min: 0, max: 0 } });
  const draftsRepo = createDraftsRepository(app.db);

  const piDeps: ProcessInboundDeps = {
    ports,
    provider: fakeProvider(),
    claims,
    settings: DEFAULT_SETTINGS,
    aiCfg: AI_CFG,
    outbox,
    drafts: draftsRepo,
    loadConversation: async (conversationId) => {
      const [c] = await app.db
        .select({ accountId: base.conversations.accountId, contactId: base.conversations.contactId })
        .from(base.conversations)
        .where(eq(base.conversations.id, conversationId))
        .limit(1);
      if (c === undefined) throw new Error('conversa inexistente no loadConversation');
      return c;
    },
  };

  const draftDeps: DraftDeps = {
    db: app.db,
    scope: { tenantId: base.MILVENDAS_TENANT_ID },
    outbox,
    audit,
    now: () => new Date(),
  };

  const fm = createFakeMessaging();
  const lifecycle = createAccountLifecycle({
    accounts: app.accounts,
    provider: fm.provider,
    notifySink,
    audit,
    cfg: { failWindow: 20, failRatio: 0.3 },
    now: () => new Date(),
  });
  const tick = {
    db: app.db,
    provider: fm.provider,
    accounts: lifecycle,
    notifySink,
    audit,
    now: (): Date => new Date(Date.now() + 10_000),
    random: (): number => 0,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    cfg: { sendTimeoutMs: 15_000, maxAttempts: 3, retryDelayMs: 1_000 },
  };

  const mkEvent = async (): Promise<string> => {
    const evId = randomUUID();
    await app.db.insert(base.inboundEvents).values({
      id: evId,
      tenantId: base.MILVENDAS_TENANT_ID,
      providerEventId: `prov-${evId}`,
      payload: {},
    });
    return evId;
  };

  return {
    app,
    piDeps,
    draftDeps,
    convId: conv.id,
    fm,
    runOutboxWorker: () => runOutboxTick(tick),
    mkEvent,
  };
}

const countOutbox = async (db: DbClient): Promise<number> =>
  (await db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length;

const messageStatus = async (db: DbClient, convId: string): Promise<string | undefined> => {
  const [m] = await db
    .select({ status: base.messages.status })
    .from(base.messages)
    .where(eq(base.messages.conversationId, convId));
  return m?.status;
};

const auditCount = async (db: DbClient, action: string): Promise<number> =>
  (await db.select({ action: base.auditLog.action }).from(base.auditLog).where(eq(base.auditLog.action, action))).length;

test('rascunho aprovado é enviado uma só vez pela outbox', async () => {
  const { app, piDeps, draftDeps, convId, fm, runOutboxWorker, mkEvent } = await setup();
  try {
    const evId = await mkEvent();
    await processInbound(piDeps, { id: evId, conversationId: convId, text: 'olá' });

    const before = await listDrafts(draftDeps, convId);
    assert.equal(before.length, 1, 'ai_suggest cria exatamente 1 rascunho');
    assert.equal(before[0]!.status, 'pending');
    assert.equal(await countOutbox(app.db), 0, 'rascunho pendente ainda não enfileira');

    const a = await approveDraft(draftDeps, before[0]!.id, app.users.agent.id);
    assert.equal((await listDrafts(draftDeps, convId))[0]!.status, 'approved');

    await runOutboxWorker();
    assert.equal(fm.sendTextCalls.length, 1, 'worker envia UMA vez');
    assert.equal(fm.sendTextCalls[0]!.text, before[0]!.text, 'o texto aprovado é o enviado');
    assert.equal(await messageStatus(app.db, convId), 'sent');

    // aprovar de novo é idempotente: mesmo outboxId, sem reenvio nem 2.º audit.
    const again = await approveDraft(draftDeps, before[0]!.id, app.users.agent.id);
    assert.equal(again.outboxId, a.outboxId, 'aprovação repetida devolve o mesmo outboxId');
    await runOutboxWorker();
    assert.equal(fm.sendTextCalls.length, 1, 'não duplica');
    assert.equal(await auditCount(app.db, 'draft.approved'), 1, '1 audit mesmo com 2 aprovações');
  } finally {
    await app.close();
  }
});

test('rascunho rejeitado não gera outbox', async () => {
  const { app, piDeps, draftDeps, convId, mkEvent } = await setup();
  try {
    const evId = await mkEvent();
    await processInbound(piDeps, { id: evId, conversationId: convId, text: 'olá' });
    const [draft] = await listDrafts(draftDeps, convId);

    const r = await rejectDraft(draftDeps, draft!.id, app.users.agent.id, 'reescrita manual');
    assert.equal(r.status, 'rejected');
    assert.equal(await countOutbox(app.db), 0, 'rejeição não enfileira nada');
    assert.equal((await listDrafts(draftDeps, convId))[0]!.status, 'rejected');
    assert.equal(await auditCount(app.db, 'draft.rejected'), 1, 'rejeição auditada');
  } finally {
    await app.close();
  }
});

test('API: sem sessão 401; papel agent aprova; aprovar rascunho rejeitado → 409', async () => {
  const { app, piDeps, draftDeps, convId, mkEvent } = await setup();
  try {
    const evA = await mkEvent();
    const evB = await mkEvent();
    await processInbound(piDeps, { id: evA, conversationId: convId, text: 'primeira' });
    await processInbound(piDeps, { id: evB, conversationId: convId, text: 'segunda' });
    const drafts = await listDrafts(draftDeps, convId);
    assert.equal(drafts.length, 2, 'uma mensagem por rascunho');
    const [draftA, draftB] = drafts;

    const auth = { session: app.sessions.agent, csrf: app.csrf.agent };
    const post = (url: string) =>
      app.inject({
        method: 'POST',
        url,
        cookies: { session: auth.session, csrf: auth.csrf },
        headers: { 'x-csrf-token': auth.csrf },
      });

    // sem sessão → 401
    const anon = await app.inject({ method: 'POST', url: `/v1/drafts/${draftA!.id}/approve` });
    assert.equal(anon.statusCode, 401);

    // papel agent pode aprovar → 200
    const ok = await post(`/v1/drafts/${draftA!.id}/approve`);
    assert.equal(ok.statusCode, 200, `esperado 200, veio ${ok.statusCode}: ${ok.body}`);
    assert.equal((ok.json() as { status: string }).status, 'approved');

    // rejeitar o 2.º rascunho e depois tentar aprová-lo → 409
    const rej = await app.inject({
      method: 'POST',
      url: `/v1/drafts/${draftB!.id}/reject`,
      cookies: { session: auth.session, csrf: auth.csrf },
      headers: { 'x-csrf-token': auth.csrf },
      payload: { reason: 'reescrita manual' },
    });
    assert.equal(rej.statusCode, 200, `esperado 200 no reject, veio ${rej.statusCode}: ${rej.body}`);
    const conflict = await post(`/v1/drafts/${draftB!.id}/approve`);
    assert.equal(conflict.statusCode, 409, `esperado 409, veio ${conflict.statusCode}: ${conflict.body}`);

    // listagem por conversa (sem csrf em GET) → os 2 rascunhos
    const list = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${convId}/drafts`,
      cookies: { session: auth.session },
    });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { drafts: unknown[] }).drafts.length, 2);
  } finally {
    await app.close();
  }
});
