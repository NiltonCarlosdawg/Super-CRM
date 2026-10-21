// Fase 3, Task 17: processInbound + testChat ponta-a-ponta contra Postgres real
// (docs/05). Fixtures sintéticas; `migratedDb()` isola cada teste (reset + tenant).
// Relógio controlado por deps.now(). WhatsApp só sai pela outbox (docs/01 §8).
//
// Reconciliações (aprovadas pelo humano):
//  • Teste 3: falhas de provider são engolidas pelo `failSafe` do orquestrador
//    (não lançam), por isso a libertação do claim é exercitada com um erro
//    TRANSITÓRIO LANÇADO (loadState lança na 1.ª tentativa) — preserva a essência
//    do plano (Review Focus nº 1: claim libertado → retry volta a claimar).
//  • Chat de teste: `handleInbound` ignora o claim quando `isTest` (não é evento
//    de webhook), por isso o testChat não precisa de linha em `inbound_events`.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';

import type { AIConfig } from '../../src/adapters/ai/config.js';
import { createDraftsRepository, type DraftsRepository } from '../../src/adapters/db/drafts.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { processInbound, type ProcessInboundDeps } from '../../src/application/process-inbound.js';
import { createTestChat } from '../../src/modules/knowledge/test-chat.js';
import { seedHandoffTriggers } from '../../src/modules/knowledge/handoff-triggers.seed.js';
import * as k from '../../src/modules/knowledge/knowledge.schema.js';
import { DEFAULT_SETTINGS } from '../../src/modules/settings/settings.js';
import type { AIProvider, AIResponse, Ports, SourceRef } from '../../src/ports/ai-provider.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { migratedDb } from '../helpers/db.js';

const T0 = Date.parse('2026-10-07T10:00:00.000Z');

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

const SOURCES: SourceRef[] = [{ type: 'chunk', id: 'c1', version: 1, score: 0.9 }];

function response(over?: Partial<AIResponse>): AIResponse {
  return {
    reply: 'Resposta de teste.',
    answered: true,
    firedTriggers: [],
    qualificationUpdates: {},
    sources: SOURCES,
    model: 'fake',
    ...over,
  };
}

function fakeProvider(over?: Partial<AIProvider>): AIProvider {
  return {
    respond: async () => response(),
    summarizeForHandoff: async () => 'resumo sintético',
    ...over,
  };
}

interface Ctx {
  db: DbClient;
  convId: string;
  deps: ProcessInboundDeps;
  notifications: NotifyEvent[];
  drafts: DraftsRepository;
}

async function setup(opts?: { aiMode?: 'ai_suggest' | 'ai_active' }): Promise<Ctx> {
  const db = await migratedDb(); // reset + tenant MilVendas

  // As 4 linhas de negócio têm de existir antes do seed de gatilhos (a seed
  // resolve lineSlug → id e falha se faltar alguma referenciada em triggerSeeds).
  await db.insert(k.businessLines).values([
    { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
    { slug: 'custom', name: 'Soluções Personalizadas', conversionGoal: 'demo_request' },
    { slug: 'telecom', name: 'Telecomunicações', conversionGoal: 'demo_request' },
    { slug: 'cctv', name: 'CCTV', conversionGoal: 'demo_request' },
  ]);
  await seedHandoffTriggers(db);

  const line = (await db
    .select({ id: k.businessLines.id })
    .from(k.businessLines)
    .where(eq(k.businessLines.slug, 'software'))
    .limit(1))[0]!;
  const account = (await db
    .insert(base.whatsappAccounts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, label: 'Vendas', phoneE164: '+244923111111', providerSessionId: 'sess-t17', purpose: 'sales' })
    .returning())[0]!;
  const contact = (await db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923222222', name: 'Cliente T17' })
    .returning())[0]!;
  const lead = (await db
    .insert(base.leads)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, contactId: contact.id, lineId: line.id, qualification: {} })
    .returning())[0]!;
  const conv = (await db
    .insert(base.conversations)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      accountId: account.id,
      contactId: contact.id,
      leadId: lead.id,
      lineId: line.id,
      ...(opts?.aiMode ? { aiMode: opts.aiMode } : {}),
    })
    .returning())[0]!;

  const notifications: NotifyEvent[] = [];
  const notifySink = async (e: NotifyEvent): Promise<void> => void notifications.push(e);

  const factory = createOrchestratorPorts({ db, notifySink, claimTtlMs: 60_000, now: () => new Date(T0) });
  const ports = factory.forTenant(base.MILVENDAS_TENANT_ID);
  const claims = { release: (eventId: string) => factory.releaseClaim(eventId, base.MILVENDAS_TENANT_ID) };

  const outbox = createOutbox({ db, notifySink, now: () => new Date(T0), random: () => 0, replyDelay: { min: 0, max: 0 } });
  const drafts = createDraftsRepository(db);

  const deps: ProcessInboundDeps = {
    ports,
    provider: fakeProvider(),
    claims,
    settings: DEFAULT_SETTINGS,
    aiCfg: AI_CFG,
    outbox,
    drafts,
    loadConversation: async (conversationId) => {
      const [c] = await db
        .select({ accountId: base.conversations.accountId, contactId: base.conversations.contactId })
        .from(base.conversations)
        .where(eq(base.conversations.id, conversationId))
        .limit(1);
      if (c === undefined) throw new Error('conversa inexistente no loadConversation');
      return c;
    },
  };

  return { db, convId: conv.id, deps, notifications, drafts };
}

/** Insere um evento de webhook real (os tests 1-3 usam mensagens não-teste → claim). */
async function insertEvent(db: DbClient, evId: string): Promise<void> {
  await db.insert(base.inboundEvents).values({
    id: evId,
    tenantId: base.MILVENDAS_TENANT_ID,
    providerEventId: `prov-${evId}`,
    payload: {},
  });
}

const aiClaimed = async (db: DbClient, evId: string): Promise<Date | null> => {
  const [r] = await db
    .select({ aiClaimedAt: base.inboundEvents.aiClaimedAt })
    .from(base.inboundEvents)
    .where(eq(base.inboundEvents.id, evId))
    .limit(1);
  return r?.aiClaimedAt ?? null;
};

const countOutbox = async (db: DbClient): Promise<number> =>
  (await db.select({ id: base.outboxMessages.id }).from(base.outboxMessages)).length;

const outboxRow = async (db: DbClient, key: string) =>
  (
    await db
      .select({ idempotencyKey: base.outboxMessages.idempotencyKey })
      .from(base.outboxMessages)
      .where(eq(base.outboxMessages.idempotencyKey, key))
  )[0];

const countHandoffs = async (db: DbClient): Promise<number> =>
  (await db.select({ id: k.handoffs.id }).from(k.handoffs)).length;

const countGaps = async (db: DbClient): Promise<number> =>
  (await db.select({ id: k.knowledgeGaps.id }).from(k.knowledgeGaps)).length;

test('ai_suggest → cria rascunho pendente, nada na outbox nem handoff', async () => {
  const { db, convId, deps, drafts } = await setup(); // conversa default ai_suggest
  const evId = randomUUID();
  await insertEvent(db, evId);

  const d: ProcessInboundDeps = {
    ...deps,
    provider: fakeProvider({
      respond: async () => response({ reply: 'Lamento muito pelo ocorrido.', firedTriggers: ['complaint'] }),
    }),
  };
  const out = await processInbound(d, { id: evId, conversationId: convId, text: 'Isto é uma vergonha' });

  assert.equal(out.status, 'ok');
  assert.equal(out.mode, 'draft');
  assert.deepEqual(out.fired, ['complaint']);
  assert.equal(await countOutbox(db), 0); // nada sai pela outbox em ai_suggest
  assert.equal(await countHandoffs(db), 0); // canAct=false (draft) → sem handoff

  const rows = await drafts.listByConversation(convId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'pending');
  assert.equal(rows[0]!.text, 'Lamento muito pelo ocorrido.');
  assert.deepEqual(rows[0]!.firedTriggers, ['complaint']);
});

test('ai_active → enfileira na outbox idempotentemente por evento', async () => {
  const { db, convId, deps } = await setup({ aiMode: 'ai_active' });
  const evId = randomUUID();
  await insertEvent(db, evId);
  const msg = { id: evId, conversationId: convId, text: 'olá' };

  const out = await processInbound(deps, msg);
  assert.equal(out.status, 'ok');
  assert.equal(out.mode, 'send');
  assert.equal(out.reply, 'Resposta de teste.');
  assert.equal(await countOutbox(db), 1);
  assert.equal((await outboxRow(db, `inbound:${evId}`))?.idempotencyKey, `inbound:${evId}`);

  // 2.ª chamada com o MESMO evento → claim falha → duplicate → sem novo enqueue.
  const dup = await processInbound(deps, msg);
  assert.equal(dup.status, 'duplicate');
  assert.equal(await countOutbox(db), 1); // inalterado
});

test('erro transitório lança → claim libertado → retry do job tem sucesso', async () => {
  const { db, convId, deps, drafts } = await setup(); // ai_suggest → draft
  const evId = randomUUID();
  await insertEvent(db, evId);
  const msg = { id: evId, conversationId: convId, text: 'olá' };

  // loadState lança na 1.ª tentativa (transiente), funciona na 2.ª.
  let calls = 0;
  const flakyPorts: Ports = {
    ...deps.ports,
    loadState: async (conversationId) => {
      calls += 1;
      if (calls === 1) throw new Error('transient-db');
      return deps.ports.loadState(conversationId);
    },
  };
  const d: ProcessInboundDeps = { ...deps, ports: flakyPorts };

  // 1.ª tentativa: lança (o catch liberta o claim) e o erro original propaga.
  await assert.rejects(processInbound(d, msg), /transient-db/);
  assert.equal(await aiClaimed(db, evId), null); // claim libertado no catch
  assert.equal((await drafts.listByConversation(convId)).length, 0); // nada criado

  // 2.ª tentativa (retry do job): claima de novo e processa com sucesso.
  const out = await processInbound(d, msg);
  assert.equal(out.status, 'ok');
  assert.equal((await drafts.listByConversation(convId)).length, 1);
});

test('chat de teste: reply + sources do answer_trace, sem efeitos', async () => {
  const { db, convId, deps, notifications } = await setup();

  const testChat = createTestChat({
    ports: deps.ports,
    provider: fakeProvider({
      respond: async () => response({ reply: 'O plano X custa 50.000 Kz.' }),
    }),
    settings: DEFAULT_SETTINGS,
    aiCfg: AI_CFG,
    conversationId: convId,
    db,
  });

  const r = await testChat({ text: 'Qual o preço do plano?' });

  assert.equal(r.reply, 'O plano X custa 50.000 Kz.');
  assert.ok(r.sources.length > 0); // vêm do answer_trace gravado pelo orquestrador
  assert.deepEqual(r.sources, SOURCES);
  assert.equal(await countHandoffs(db), 0); // isTest → canAct=false
  assert.equal(await countGaps(db), 0); // isTest → recordGap desligado
  assert.equal(notifications.length, 0); // isTest → sem notificações
});
