// Fase 3 — modo LLM do eval (docs/05 §8, A3): selecção de modo, candidatos,
// transporte com pacing (Groq 30 RPM), runLlmEval com provider falso (violação
// mustNot + erro por cenário sem abortar) e formato do relatório combinado.
// Tudo sem rede e determinístico.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIProvider } from '../../src/ports/ai-provider.js';
import type { LLMCallResult, LLMTransport } from '../../src/ports/llm-transport.js';
import { scenarios } from '../../src/modules/evaluation/handoff-scenarios.js';
import {
  EVAL_PACING_MS,
  createPacingTransport,
  parseCandidates,
  renderLlmEvalReport,
  resolveEvalMode,
  resolvePacingMs,
  runLlmEval,
} from '../../src/modules/evaluation/llm-eval.js';

test('resolveEvalMode: --baseline força baseline; sem chave → baseline; com chave → llm', () => {
  assert.equal(resolveEvalMode(['--baseline'], { AI_API_KEY: 'x' }), 'baseline');
  assert.equal(resolveEvalMode(['scripts/eval.ts', '--baseline'], { AI_API_KEY: 'x' }), 'baseline');
  assert.equal(resolveEvalMode([], { AI_API_KEY: 'x' }), 'llm');
  assert.equal(resolveEvalMode([], { AI_API_KEY: '' }), 'baseline');
  assert.equal(resolveEvalMode([], {}), 'baseline');
});

test('resolvePacingMs: default 2100; EVAL_PACING_MS válido respeita; inválido cai no default', () => {
  assert.equal(resolvePacingMs({}), EVAL_PACING_MS);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: '' }), EVAL_PACING_MS);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: '   ' }), EVAL_PACING_MS);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: 'abc' }), EVAL_PACING_MS);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: '-5' }), EVAL_PACING_MS);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: '4500' }), 4500);
  assert.equal(resolvePacingMs({ EVAL_PACING_MS: '0' }), 0);
});

test('parseCandidates: lista por vírgula; vazio/ausente → fallback', () => {
  assert.deepEqual(parseCandidates(' llama-3.3-70b , llama-3.1-8b ', 'fb'), [
    'llama-3.3-70b',
    'llama-3.1-8b',
  ]);
  assert.deepEqual(parseCandidates(' , ', 'fb'), ['fb']);
  assert.deepEqual(parseCandidates(undefined, 'fb'), ['fb']);
  assert.deepEqual(parseCandidates('', 'fb'), ['fb']);
});

test('createPacingTransport: dorme ANTES de cada chamada e preserva a resposta', async () => {
  const slept: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
  };
  const order: string[] = [];
  const inner: LLMTransport = {
    name: 'fake',
    async call(): Promise<LLMCallResult> {
      order.push('call');
      return { content: 'ok', toolCall: null, model: 'm' };
    },
  };
  const paced = createPacingTransport(inner, sleep);

  const result = await paced.call({ model: 'm', messages: [], tools: [], maxTokens: 10 }, new AbortController().signal);

  assert.deepEqual(slept, [EVAL_PACING_MS]);
  assert.deepEqual(order, ['call'], 'sleep acontece antes da chamada real');
  assert.equal(result.content, 'ok');
  assert.equal(paced.name, 'fake');

  // Erros do transporte interno propagam (o retry continua a cargo do callWithPolicy).
  const failing: LLMTransport = {
    name: 'fake',
    async call(): Promise<LLMCallResult> {
      throw new Error('boom transport');
    },
  };
  await assert.rejects(
    createPacingTransport(failing, sleep, 5).call(
      { model: 'm', messages: [], tools: [], maxTokens: 10 },
      new AbortController().signal,
    ),
    /boom transport/,
  );
});

test('runLlmEval: violação mustNot, erro por cenário isolado e métricas por candidato', async () => {
  const pi01 = scenarios.find((s) => s.id === 'pi-01');
  const hr04 = scenarios.find((s) => s.id === 'hr-04');
  assert.ok(pi01 && hr04, 'cenários pi-01 e hr-04 existem');

  const madeFor: string[] = [];
  const makeProvider = (model: string): AIProvider => {
    madeFor.push(model);
    return {
      async respond(req) {
        const id = req.conversationId.replace('eval:', '');
        if (id === 'hr-04') throw new Error('boom');
        if (id === 'pi-01') {
          return {
            reply: 'Confirmei o pagamento com sucesso.',
            answered: true,
            firedTriggers: ['purchase_intent'],
            qualificationUpdates: {},
            sources: [],
            model,
          };
        }
        return {
          reply: 'Sem problema.',
          answered: true,
          firedTriggers: [],
          qualificationUpdates: {},
          sources: [],
          model,
        };
      },
      async summarizeForHandoff() {
        return 'resumo';
      },
      async extractKnowledge() {
        return { items: [] };
      },
    };
  };

  const { candidates } = await runLlmEval({
    candidates: ['model-a', 'model-b'],
    makeProvider,
    list: [pi01, hr04],
  });

  assert.deepEqual(madeFor, ['model-a', 'model-b'], 'um provider por candidato');
  assert.equal(candidates.length, 2);

  const [a, b] = candidates;
  assert.equal(a.model, 'model-a');
  assert.equal(a.scenarios, 2);
  // Violação detectada: reply de pi-01 contém "Confirmei o pagamento".
  assert.equal(a.mustNot.length, 1);
  assert.equal(a.mustNot[0]?.id, 'pi-01');
  assert.equal(a.mustNot[0]?.behavior, 'process_payment');
  // Erro isolado: hr-04 falhou no provider → errors, sem abortar a corrida.
  assert.equal(a.errors.length, 1);
  assert.equal(a.errors[0]?.id, 'hr-04');
  assert.match(a.errors[0]?.error ?? '', /^Error: boom$/);
  // Métricas: pi-01 tp em purchase_intent; hr-04 sem resposta → fn em human_requested.
  assert.equal(a.metrics.purchase_intent?.tp, 1);
  assert.equal(a.metrics.purchase_intent?.precision, 1);
  assert.equal(a.metrics.human_requested?.fn, 1);
  assert.equal(a.metrics.human_requested?.recall, 0);
  assert.deepEqual(a.misses.map((m) => m.id), ['hr-04']);
  assert.deepEqual(a.ambiguous, []);
  // Candidato independente: mesmos resultados com o seu model.
  assert.equal(b.model, 'model-b');
  assert.equal(b.mustNot.length, 1);
  assert.equal(b.errors.length, 1);
});

test('renderLlmEvalReport: tabela comparativa, secções por candidato, mustNot e errors', () => {
  const md = renderLlmEvalReport([
    {
      model: 'llama-3.3-70b-versatile',
      metrics: {
        purchase_intent: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 },
        human_requested: { tp: 0, fp: 0, fn: 1, precision: null, recall: 0 },
      },
      misses: [{ id: 'hr-04' }],
      ambiguous: [],
      mustNot: [
        {
          id: 'pi-01',
          behavior: 'process_payment',
          reply: 'Confirmei o pagamento com sucesso.',
          verdict: 'violation',
        },
      ],
      errors: [{ id: 'hr-04', error: 'Error: boom' }],
      scenarios: 80,
    },
    {
      model: 'llama-3.1-8b-instant',
      metrics: { purchase_intent: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 } },
      misses: [],
      ambiguous: [],
      mustNot: [],
      errors: [],
      scenarios: 80,
    },
  ]);

  assert.match(md, /^# Eval \(LLM\) — \d{4}-\d{2}-\d{2}$/m);
  assert.match(md, /\| model \| misses \| mustNot \| errors \|/);
  assert.match(md, /\| llama-3\.3-70b-versatile \| 1 \| 1 \| 1 \|/);
  assert.match(md, /\| llama-3\.1-8b-instant \| 0 \| 0 \| 0 \|/);
  assert.match(md, /^## llama-3\.3-70b-versatile$/m);
  assert.match(md, /^### Misses$/m, 'secções aninhadas em nível 3');
  assert.match(md, /^- hr-04$/m);
  assert.match(md, /^### mustNot violations$/m);
  assert.match(md, /^- pi-01: process_payment/m);
  assert.match(md, /^### errors$/m);
  assert.match(md, /^- hr-04: Error: boom$/m);
  assert.match(md, /^Scenarios: 80 \(base 72 \+ adversariais 8\)$/m);
  // Candidato limpo não ganha secção de errors.
  const second = md.slice(md.indexOf('## llama-3.1-8b-instant'));
  assert.ok(!second.includes('### errors'), 'sem erros → sem secção errors');
  assert.match(second, /^\(nenhum\)$/m, 'mustNot vazio → (nenhum)');
});
