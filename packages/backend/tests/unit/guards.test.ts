// Fase 3, Task 11: as cinco guardas determinísticas (docs/05 §6).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedSourceIds,
  applyBlockingGuards,
  filterSources,
  HUMAN_CLAIM_PATTERNS,
  normalizeMoney,
} from '../../src/domain/guards.js';
import type {
  AIRequest,
  CatalogFact,
  RetrievedChunk,
  RuleDef,
} from '../../src/ports/ai-provider.js';

function aiRequest(overrides: Partial<AIRequest> = {}): AIRequest {
  return {
    conversationId: 'conv-1',
    line: 'software',
    turns: [],
    chunks: [],
    rules: [],
    qualification: { questions: [], answers: {} },
    triggers: [],
    lookupCatalog: async () => [],
    mode: 'draft',
    ...overrides,
  };
}
const chunk = (id: string): RetrievedChunk => ({
  id,
  source: 'doc',
  sourceId: id,
  content: '',
  similarity: 1,
  version: 1,
});
const rule = (id: string): RuleDef => ({
  id,
  kind: 'tone',
  title: '',
  instruction: '',
  lineSlug: null,
  params: null,
});
const fact = (id: string, priceAmount: string | null): CatalogFact => ({
  id,
  name: '',
  summary: '',
  pricingMode: 'fixed',
  priceAmount,
  currency: 'AOA',
  availability: 'available',
  version: 1,
});

test('1. fontes só deste turno', () => {
  const req = aiRequest({ chunks: [chunk('c1')], rules: [rule('r1')] });
  const facts = [fact('k1', '250.00')];
  assert.deepEqual([...allowedSourceIds(req, facts)].sort(), ['c1', 'k1', 'r1']);
  assert.deepEqual(
    filterSources(
      [
        { type: 'catalog', id: 'k9' },
        { type: 'chunk', id: 'c1' },
        { type: 'rule', id: 'r1' },
      ],
      allowedSourceIds(req, facts),
    ),
    [
      { type: 'chunk', id: 'c1' },
      { type: 'rule', id: 'r1' },
    ],
  );
});

test('2. guarda de preços: só aceita preço do catálogo', () => {
  assert.deepEqual(
    applyBlockingGuards({
      line: 'software',
      reply: 'O plano custa 250,00 Kz.',
      answered: true,
      sources: [],
      catalogPrices: ['250.00'],
    }).blocked,
    [],
  );
  const b2 = applyBlockingGuards({
    line: 'software',
    reply: 'O plano custa 300,00 Kz.',
    answered: true,
    sources: [],
    catalogPrices: ['250.00'],
  });
  assert.deepEqual(b2.blocked, ['price_mismatch']);
  assert.equal(b2.reply, null);
  assert.equal(b2.answered, false);
  assert.equal(normalizeMoney('1.500.000,00 Kz'), '1500000.00');
});

test('3. guarda custom: qualquer preço ou prazo bloqueia', () => {
  assert.deepEqual(
    applyBlockingGuards({
      line: 'custom',
      reply: 'Ficamos combinados: fica pronto em 3 semanas.',
      answered: true,
      sources: [],
      catalogPrices: [],
    }).blocked,
    ['custom_price_or_deadline'],
  );
  assert.deepEqual(
    applyBlockingGuards({
      line: 'custom',
      reply: 'Solução sob medida: 500.000 Kz.',
      answered: true,
      sources: [],
      catalogPrices: [],
    }).blocked,
    ['custom_price_or_deadline'],
  );
  assert.deepEqual(
    applyBlockingGuards({
      line: 'custom',
      reply: 'Vamos qualificar o problema e o âmbito.',
      answered: true,
      sources: [],
      catalogPrices: [],
    }).blocked,
    [],
  );
});

test('4. guarda factos sem fonte', () => {
  assert.deepEqual(
    applyBlockingGuards({
      line: 'telecom',
      reply: 'Temos cobertura em Cacuaco e ativa em 2 dias.',
      answered: true,
      sources: [],
      catalogPrices: [],
    }).blocked,
    ['facts_without_source'],
  );
  assert.deepEqual(
    applyBlockingGuards({
      line: 'telecom',
      reply: 'Claro, posso ajudar com isso.',
      answered: true,
      sources: [],
      catalogPrices: [],
    }).blocked,
    [],
  );
});

test('5. guarda fingir ser humano', () => {
  assert.deepEqual(
    applyBlockingGuards({
      line: null,
      reply: 'Falo consigo como um humano, sem robôs.',
      answered: true,
      sources: [{ type: 'chunk', id: 'c1' }],
      catalogPrices: [],
    }).blocked,
    ['claims_to_be_human'],
  );
  assert.deepEqual(
    applyBlockingGuards({
      line: null,
      reply: 'Sou um assistente virtual da MilVendas.',
      answered: true,
      sources: [{ type: 'chunk', id: 'c1' }],
      catalogPrices: [],
    }).blocked,
    [],
  );
});

test('guarda 5: cada padrão deteta o seu positivo e ignora o seu negativo', () => {
  const pos = [
    'Sou um humano a falar.',
    'Falo consigo como um humano.',
    'Não sou um robô.',
    'Aqui fala um humano.',
    'De pessoa para pessoa.',
  ];
  const neg = [
    'Sou um assistente virtual da MilVendas.',
    'Falo consigo sobre o plano.',
    'Sou um assistente que responde rápido.',
    'Aqui fala a equipa MilVendas.',
    'Vamos ver os planos disponíveis.',
  ];
  assert.equal(HUMAN_CLAIM_PATTERNS.length, 5);
  HUMAN_CLAIM_PATTERNS.forEach((re, i) => {
    assert.match(pos[i]!, re);
    assert.doesNotMatch(neg[i]!, re);
  });
});
