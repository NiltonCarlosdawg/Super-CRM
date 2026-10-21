// Fase 1, Task 14: Ports do orquestrador contra Postgres real (docs/05 §3-§5).
// Relógio controlado por deps.now() em TODO o SQL; fixtures sintéticas.

import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { normalizeQuestion } from '../../src/domain/question.js';
import * as k from '../../src/modules/knowledge/knowledge.schema.js';
import { migratedDb } from '../helpers/db.js';

const T0 = Date.parse('2026-10-07T10:00:00.000Z');

const noNotify = async (): Promise<void> => {};

function portsFor(db: DbClient, extra?: { turnsLimit?: number; retrieve?: unknown }) {
  // Onda 1 (Task 5): os ports são de UM tenant (`forTenant`); os fixtures são
  // do tenant MilVendas.
  return createOrchestratorPorts({
    db,
    notifySink: noNotify,
    claimTtlMs: 60_000,
    now: () => new Date(T0),
    ...extra,
  }).forTenant(base.MILVENDAS_TENANT_ID);
}

/** Linha + conta + contacto + lead + conversa com 2 mensagens (ai → cliente). */
async function seedConversation(db: DbClient) {
  const line = (await db
    .insert(k.businessLines)
    .values({ slug: 'software', name: 'Software', conversionGoal: 'demo_request' })
    .returning())[0]!;
  const account = (await db
    .insert(base.whatsappAccounts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, label: 'Vendas', phoneE164: '+244923111111', providerSessionId: 'sess-t14', purpose: 'sales' })
    .returning())[0]!;
  const contact = (await db
    .insert(base.contacts)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923222222', name: 'Cliente T14' })
    .returning())[0]!;
  const lead = (await db
    .insert(base.leads)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, contactId: contact.id, lineId: line.id, qualification: {} })
    .returning())[0]!;
  const conversation = (await db
    .insert(base.conversations)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId: account.id, contactId: contact.id, leadId: lead.id, lineId: line.id })
    .returning())[0]!;
  await db.insert(base.messages).values([
    { tenantId: base.MILVENDAS_TENANT_ID, conversationId: conversation.id, accountId: account.id, direction: 'outbound', sender: 'ai',
      body: 'Bom dia! Como posso ajudar?', createdAt: new Date(T0) },
    { tenantId: base.MILVENDAS_TENANT_ID, conversationId: conversation.id, accountId: account.id, direction: 'inbound', sender: 'customer',
      body: 'olá', createdAt: new Date(T0 + 1_000) },
  ]);
  return { line, account, contact, lead, conversation };
}

test('claimMessage: true, false, stale re-claim após claimTtlMs e releaseClaim', async () => {
  const db = await migratedDb();
  let t = T0;
  const factory = createOrchestratorPorts({ db, notifySink: noNotify, claimTtlMs: 60_000, now: () => new Date(t) });
  const ports = factory.forTenant(base.MILVENDAS_TENANT_ID);
  // Onda 1 (Task 5): o evento pertence ao tenant (marcado no job quando a
  // conta resolve) — o claim é por (id, tenant_id).
  const ev = (await db
    .insert(base.inboundEvents)
    .values({ tenantId: base.MILVENDAS_TENANT_ID, providerEventId: 'evt-claim-1', payload: { synth: true } })
    .returning())[0]!;

  assert.equal(await ports.claimMessage(ev.id), true);
  assert.equal(await ports.claimMessage(ev.id), false, 'outro worker não entra');
  t += 60_001; // claim expirou (crash a meio)
  assert.equal(await ports.claimMessage(ev.id), true, 're-claim após TTL');
  await factory.releaseClaim(ev.id, base.MILVENDAS_TENANT_ID); // caminho de erro da Task 19
  assert.equal(await ports.claimMessage(ev.id), true, 'releaseClaim liberta');

  // relógio controlado: o claim ficou gravado com deps.now()
  const [row] = await db.select().from(base.inboundEvents).where(eq(base.inboundEvents.id, ev.id));
  assert.equal(row?.aiClaimedAt?.getTime(), t);
});

test('estado: saveState grava ai_mode, miss_streak e qualification no lead; loadState devolve turnos incluindo a atual', async () => {
  const db = await migratedDb();
  const { conversation, lead } = await seedConversation(db);
  const ports = portsFor(db);

  const state = await ports.loadState(conversation.id);
  assert.equal(state.line, 'software');
  assert.equal(state.aiMode, 'ai_suggest'); // default D13
  assert.equal(state.missStreak, 0);
  assert.deepEqual(state.answers, {});
  assert.equal(state.turns.length, 2);
  assert.equal(state.turns[0]?.from, 'ai');
  assert.equal(state.turns[1]?.from, 'customer', 'último turno é o do cliente (mensagem atual já guardada)');

  await ports.saveState(conversation.id, { aiMode: 'human_only', missStreak: 1, answers: { empresa: 'MilVendas' } });
  const re = await ports.loadState(conversation.id);
  assert.equal(re.aiMode, 'human_only');
  assert.equal(re.missStreak, 1);
  assert.deepEqual(re.answers, { empresa: 'MilVendas' });
  const [leadRow] = await db.select().from(base.leads).where(eq(base.leads.id, lead.id));
  assert.deepEqual(leadRow?.qualification, { empresa: 'MilVendas' }, 'qualification persistida no lead');

  // patch parcial não toca nos restantes campos (COALESCE)
  await ports.saveState(conversation.id, { missStreak: 2 });
  const re2 = await ports.loadState(conversation.id);
  assert.equal(re2.aiMode, 'human_only');
  assert.equal(re2.missStreak, 2);

  // turnsLimit corta os mais antigos, mantendo o atual
  const p1 = createOrchestratorPorts({
    db, notifySink: noNotify, claimTtlMs: 60_000, now: () => new Date(T0), turnsLimit: 1,
  }).forTenant(base.MILVENDAS_TENANT_ID);
  const s1 = await p1.loadState(conversation.id);
  assert.equal(s1.turns.length, 1);
  assert.equal(s1.turns[0]?.from, 'customer');
});

test('conhecimento: só itens publicados e válidos; gatilhos globais + da linha; notify em pass-through', async () => {
  const db = await migratedDb();
  const { line, conversation } = await seedConversation(db);
  const ports = portsFor(db);
  const owner = '00000000-0000-4000-8000-000000000001';

  // regras: da linha (publicada) + global ativa + global expirada (archived)
  const ruleLine = (await db.insert(k.rules).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    lineId: line.id, kind: 'tone', title: 'Tom formal', instruction: 'Tratar por Você.',
    status: 'published', ownerId: owner, priority: 10,
  }).returning())[0]!;
  const ruleGlobal = (await db.insert(k.rules).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    lineId: null, kind: 'may_promise', title: 'Promessas', instruction: 'Nunca prometer prazo.',
    status: 'published', ownerId: owner,
  }).returning())[0]!;
  await db.insert(k.rules).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    lineId: null, kind: 'discount_limit', title: 'Desconto velho', instruction: 'Até 50%.',
    status: 'archived', ownerId: owner,
  });

  // pergunta ativa + inativa
  await db.insert(k.qualificationQuestions).values([
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, key: 'empresa', question: 'Como se chama a sua empresa?', active: true },
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, key: 'orcamento', question: 'Qual o orçamento?', active: false },
  ]);

  // gatilhos: global + da linha (ativos) + inativo
  await db.insert(k.handoffTriggers).values([
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: null, code: 'HUMAN_REQUESTED', description: 'Cliente pede humano',
      detectionHint: 'pedir atendimento humano', action: 'handoff_now', priority: 'high', active: true },
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, code: 'PRICE_NEGOTIATION', description: 'Negociação de preço',
      detectionHint: 'pedir desconto', action: 'handoff_now', priority: 'normal', active: true },
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, code: 'OUT_OF_SCOPE', description: 'Fora de âmbito',
      detectionHint: 'assunto alheio', action: 'flag_only', priority: 'normal', active: false },
  ]);

  // catálogo: publicado válido + rascunho + publicado expirado
  const past = new Date(T0 - 86_400_000);
  await db.insert(k.catalogItems).values([
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, kind: 'service', name: 'CRM à medida', slug: 'crm-medida', summary: 'CRM personalizado',
      pricingMode: 'quote_only', status: 'published', ownerId: owner },
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, kind: 'service', name: 'CRM rascunho', slug: 'crm-rascunho', summary: 'ainda não pronto',
      pricingMode: 'quote_only', status: 'draft', ownerId: owner },
    { tenantId: base.MILVENDAS_TENANT_ID, lineId: line.id, kind: 'service', name: 'CRM expirado', slug: 'crm-expirado', summary: 'campanha antiga',
      pricingMode: 'fixed', priceAmount: '100.00', status: 'published', validUntil: past, ownerId: owner },
  ]);

  // rules: só a da linha e a global ativa (a expirada fica de fora)
  const ruleIds = (await ports.rules('software')).map((r) => r.id).sort();
  assert.deepEqual(ruleIds, [ruleGlobal.id, ruleLine.id].sort());
  assert.deepEqual((await ports.rules(null)).map((r) => r.id), [ruleGlobal.id], 'line null → só globais');

  // questions: só a ativa
  assert.deepEqual((await ports.questions('software')).map((q) => q.key), ['empresa']);
  assert.deepEqual(await ports.questions(null), [], 'perguntas são por linha');

  // triggers: global + da linha, com lineSlug correto; inativo fora
  const triggers = await ports.triggers('software');
  assert.deepEqual(triggers.map((t) => t.code).sort(), ['HUMAN_REQUESTED', 'PRICE_NEGOTIATION']);
  assert.equal(triggers.find((t) => t.code === 'HUMAN_REQUESTED')?.lineSlug, null);
  assert.equal(triggers.find((t) => t.code === 'PRICE_NEGOTIATION')?.lineSlug, 'software');

  // retrieve: default []; injetado é usado
  assert.deepEqual(await ports.retrieve('olá', 'software'), [], 'default [] (searchChunks é Fase 2/3)');
  const injected = [{ id: 'c1', source: 'doc' as const, sourceId: 'd1', content: 'texto', similarity: 0.9, version: 1 }];
  const pRet = createOrchestratorPorts({
    db, notifySink: noNotify, claimTtlMs: 60_000, now: () => new Date(T0),
    retrieve: async () => injected,
  }).forTenant(base.MILVENDAS_TENANT_ID);
  assert.deepEqual(await pRet.retrieve('olá', 'software'), injected);

  // lookupCatalog: só publicado e dentro da validade; line null → []
  const facts = await ports.lookupCatalog('crm', 'software');
  assert.deepEqual(facts.map((f) => f.name), ['CRM à medida']);
  assert.deepEqual(await ports.lookupCatalog('crm', null), []);

  // handoff: create → findOpen → bump sobe só
  const handoffId = await ports.createHandoff({
    conversationId: conversation.id, triggerId: null, reason: 'pedido de humano',
    summary: 'Cliente pediu atendimento.', leadSnapshot: { empresa: 'MilVendas' }, priority: 'normal',
  });
  assert.ok(handoffId);
  assert.deepEqual(await ports.findOpenHandoff(conversation.id), { id: handoffId, priority: 'normal' });
  await ports.bumpHandoffPriority(handoffId, 'high');
  assert.equal((await ports.findOpenHandoff(conversation.id))?.priority, 'high', 'normal → high sobe');
  await ports.bumpHandoffPriority(handoffId, 'normal');
  assert.equal((await ports.findOpenHandoff(conversation.id))?.priority, 'high', 'high → normal NÃO desce');
  await ports.bumpHandoffPriority(handoffId, 'urgent');
  assert.equal((await ports.findOpenHandoff(conversation.id))?.priority, 'urgent', 'high → urgent sobe');

  // recordGap: variações de espaços/caixa agrupam (normalizeQuestion) → occurrences 2
  await ports.recordGap({ question: '  Quanto   CUSTA o software? ', conversationId: conversation.id, line: 'software' });
  await ports.recordGap({ question: 'quanto custa o software?', conversationId: conversation.id, line: 'software' });
  await ports.recordGap({ question: 'Tem suporte 24/7?', conversationId: conversation.id, line: 'software' });
  const gaps = await db.select().from(k.knowledgeGaps).orderBy(k.knowledgeGaps.normalizedQuestion);
  assert.equal(gaps.length, 2, 'perguntas diferentes → lacunas separadas');
  assert.equal(gaps[0]?.normalizedQuestion, normalizeQuestion('quanto custa o software?'));
  assert.equal(gaps[0]?.occurrences, 2, 'repetições contam na mesma lacuna');
  assert.equal(gaps[1]?.normalizedQuestion, 'tem suporte 24/7?');

  // saveTrace: persiste com campos intactos
  await ports.saveTrace({
    conversationId: conversation.id, question: 'olá', answer: 'Bom dia!', isTest: true,
    sources: [{ type: 'chunk', id: 'c1', version: 1, score: 0.9 }], model: 'modelo-teste', handoffId, latencyMs: 12,
  });
  const [trace] = await db.select().from(k.answerTraces).where(eq(k.answerTraces.conversationId, conversation.id));
  assert.equal(trace?.isTest, true);
  assert.equal(trace?.model, 'modelo-teste');
  assert.deepEqual(trace?.sources, [{ type: 'chunk', id: 'c1', version: 1, score: 0.9 }]);

  // notify: pass-through intacto, incluindo campo extra (ex. da Fase 3)
  const seen: unknown[] = [];
  const pNotify = createOrchestratorPorts({
    db, notifySink: async (e) => { seen.push(e); }, claimTtlMs: 60_000, now: () => new Date(T0),
  }).forTenant(base.MILVENDAS_TENANT_ID);
  const payload = {
    type: 'handoff', handoffId, conversationId: conversation.id, priority: 'urgent',
    reason: 'pedido de humano', x: 'extra',
  } as Parameters<typeof pNotify.notify>[0];
  await pNotify.notify(payload);
  // R31: o wrapper do tenant COSTURA o tenantId — o sink recebe o evento
  // intacto (pass-through da Fase 3) + o tenant dono para as salas realtime.
  assert.deepEqual(seen[0], { ...payload, tenantId: base.MILVENDAS_TENANT_ID });
});
