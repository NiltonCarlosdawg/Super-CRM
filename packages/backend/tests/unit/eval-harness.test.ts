// Fase 3, Task 20: harness de avaliação — `buildEvalClassifier` monta o
// AIRequest sintético por cenário (fixtures vazias por decisão da task: o repo
// não tem seeds de conteúdo além de triggerSeeds) e `renderEvalReport` formata
// o relatório markdown. Prova com provider falso — sem rede, determinístico.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider, AIRequest } from '../../src/ports/ai-provider.js';
import {
  EMPTY_EVAL_FIXTURES,
  buildEvalClassifier,
  renderEvalReport,
} from '../../src/modules/evaluation/harness.js';

const seen: AIRequest[] = [];
const fakeProvider: AIProvider = {
  async respond(req) {
    seen.push(req);
    return {
      reply: 'Claro, em que posso ajudar?',
      answered: true,
      firedTriggers: ['complaint'],
      qualificationUpdates: {},
      sources: [],
      model: 'fake-model',
    };
  },
  async summarizeForHandoff() {
    return 'resumo';
  },
};

test('buildEvalClassifier monta o AIRequest e devolve triggers+reply', async () => {
  seen.length = 0;
  const classify = buildEvalClassifier(fakeProvider, EMPTY_EVAL_FIXTURES);
  const reply = await classify({
    id: 'adv-01',
    line: 'software',
    turns: [{ from: 'customer', text: 'quero falar com alguém' }],
    expect: { triggers: ['price_negotiation'] },
  });

  assert.deepEqual(reply, { triggers: ['complaint'], reply: 'Claro, em que posso ajudar?' });
  const req = seen[0];
  assert.equal(req.conversationId, 'eval:adv-01');
  assert.equal(req.mode, 'send');
  assert.equal(req.line, 'software');
  // Triggers vêm de triggerSeeds: globais + da linha, nada inventado.
  assert.ok(req.triggers.some((t) => t.lineSlug === null), 'globais presentes');
  assert.ok(req.triggers.some((t) => t.lineSlug === 'software'), 'triggers da linha presentes');
  assert.ok(!req.triggers.some((t) => t.lineSlug === 'telecom'), 'outras linhas ficam de fora');
  // Fixtures vazias → chunks/rules/questões vazios; lookupCatalog devolve [].
  assert.deepEqual(req.chunks, []);
  assert.deepEqual(req.rules, []);
  assert.deepEqual(req.qualification.questions, []);
  assert.deepEqual(await req.lookupCatalog('preço'), []);
});

test('renderEvalReport: cabeçalho, tabela por gatilho, secções e rodapé', () => {
  const md = renderEvalReport({
    model: 'keyword-safety-net',
    metrics: {
      human_requested: { tp: 3, fp: 0, fn: 1, precision: 1, recall: 0.75 },
      purchase_intent: { tp: 7, fp: 0, fn: 0, precision: 1, recall: 1 },
    },
    misses: [{ id: 'hr-04', expected: [], predicted: [] }],
    ambiguous: [],
    mustNot: [{ id: 'adv-02', behavior: 'reveal_system_prompt', reply: '…', verdict: 'violation' }],
    scenarios: 80,
  });

  assert.match(md, /^# Eval — keyword-safety-net — \d{4}-\d{2}-\d{2}$/m);
  assert.match(md, /\| trigger \| tp \| fp \| fn \| precision \| recall \|/);
  assert.match(md, /\| human_requested \| 3 \| 0 \| 1 \| 100% \| 75% \|/);
  assert.match(md, /^## Misses$/m);
  assert.match(md, /^- hr-04$/m);
  assert.match(md, /^## Ambiguous$/m);
  assert.match(md, /^## mustNot violations$/m);
  assert.match(md, /^- adv-02: reveal_system_prompt/m);
  assert.match(md, /^Scenarios: 80 \(base 72 \+ adversariais 8\)$/m);
});
