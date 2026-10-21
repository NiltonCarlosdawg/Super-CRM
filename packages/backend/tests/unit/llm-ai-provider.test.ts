// Fase 3, Task 12: AIProvider real (composição). Todos os caminhos usam transporte
// falso com guião (tests/helpers/fake-llm.ts) — sem rede, sem chave.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIConfig } from '../../src/adapters/ai/config.js';
import { LLMError } from '../../src/adapters/ai/llm-client.js';
import {
  AIGateError,
  createLlmAIProvider,
  type LlmProviderDeps,
} from '../../src/adapters/ai/llm-ai-provider.js';
import { AIValidationError } from '../../src/adapters/ai/submit-response.js';
import type {
  AIRequest,
  RetrievedChunk,
  RuleDef,
} from '../../src/ports/ai-provider.js';
import type { LLMTransport } from '../../src/ports/llm-transport.js';
import {
  err,
  fakeLlm,
  hang,
  ok,
  textResult,
  toolCallResult,
} from '../helpers/fake-llm.js';

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
const discountRule = (pct: number): RuleDef => ({
  id: 'r-disc',
  kind: 'discount_limit',
  title: 'Desconto',
  instruction: '',
  lineSlug: null,
  params: { maxDiscountPct: pct },
});

function cfg(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: 'openai',
    model: 'modelo-y',
    baseUrl: null,
    apiKey: null,
    timeoutMs: 20000,
    maxRetries: 2,
    maxTokens: 1024,
    historyTurns: 10,
    retrievalTopK: 5,
    retrievalMinSimilarity: 0.75,
    missStreakLimit: 2,
    dataApproved: true,
    ...overrides,
  };
}

function makeDeps(transport: LLMTransport, config: AIConfig) {
  const sleeps: number[] = [];
  const deps: LlmProviderDeps = {
    transport,
    config,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => 0, // fixo → latencyMs determinístico (0)
  };
  return { deps, sleeps };
}

const submitOk = (reply: string, extra: Record<string, unknown> = {}) =>
  toolCallResult('submit_response', {
    reply,
    answered: true,
    firedTriggers: [],
    qualificationUpdates: {},
    sources: [],
    ...extra,
  });

test('gate A11 fechado: AIGateError e 0 chamadas', async () => {
  const { transport, calls } = fakeLlm([]);
  const { deps } = makeDeps(transport, cfg({ dataApproved: false }));
  const p = createLlmAIProvider(deps);
  await assert.rejects(p.respond(aiRequest()), (e: AIGateError) => e instanceof AIGateError);
  assert.equal(calls.length, 0);
});

test('resposta válida num só turno', async () => {
  const { transport, calls } = fakeLlm([
    ok(
      toolCallResult('submit_response', {
        reply: 'Olá',
        answered: true,
        firedTriggers: [],
        qualificationUpdates: { cliente: 'Ana' },
        sources: [{ type: 'chunk', id: 'c1' }],
      }),
    ),
  ]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const res = await p.respond(aiRequest({ chunks: [chunk('c1')] }));
  assert.deepEqual(res, {
    reply: 'Olá',
    answered: true,
    firedTriggers: [],
    qualificationUpdates: { cliente: 'Ana' },
    sources: [{ type: 'chunk', id: 'c1' }],
    model: 'modelo-x',
    latencyMs: 0,
  });
  assert.equal(calls.length, 1);
});

test('esquema inválido: 1 repetição e depois sucesso (2 chamadas)', async () => {
  const bad = toolCallResult('submit_response', { reply: 'Olá', answered: 'sim' });
  const { transport, calls } = fakeLlm([ok(bad), ok(submitOk('Certo'))]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const res = await p.respond(aiRequest());
  assert.equal(res.reply, 'Certo');
  assert.equal(calls.length, 2);
});

test('esquema inválido 2× → AIValidationError e exatamente 2 chamadas', async () => {
  const bad = toolCallResult('submit_response', { answered: true });
  const { transport, calls } = fakeLlm([ok(bad), ok(bad)]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  await assert.rejects(p.respond(aiRequest()), (e: AIValidationError) => e instanceof AIValidationError);
  assert.equal(calls.length, 2);
});

test('timeout: AIError kind timeout, 1 chamada', async () => {
  const { transport, calls } = fakeLlm([hang]);
  const { deps } = makeDeps(transport, cfg({ timeoutMs: 30 }));
  const p = createLlmAIProvider(deps);
  await assert.rejects(p.respond(aiRequest()), (e: LLMError) => e.kind === 'timeout');
  assert.equal(calls.length, 1);
});

test('429 com backoff: 2 chamadas, sleep 1250', async () => {
  const { transport, calls } = fakeLlm([
    err(new LLMError('rate limit', 'rate_limit', 429)),
    ok(submitOk('Ok')),
  ]);
  const { deps, sleeps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const res = await p.respond(aiRequest());
  assert.equal(res.reply, 'Ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1250]);
});

test('lookup_catalog acima do teto → price_negotiation', async () => {
  const { transport, calls } = fakeLlm([
    ok(toolCallResult('lookup_catalog', { query: 'plano', discountPct: 30 })),
    ok(
      submitOk('Vou encaminhar para a equipa.', {
        answered: false,
        firedTriggers: ['price_negotiation'],
      }),
    ),
  ]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const res = await p.respond(aiRequest({ rules: [discountRule(10)] }));
  assert.deepEqual(res.firedTriggers, ['price_negotiation']);
  assert.ok(!res.reply?.includes('Kz'));
  assert.equal(calls.length, 2);
});

test('preço em custom é bloqueado mas estimate_request mantém-se', async () => {
  const { transport, calls } = fakeLlm([
    ok(submitOk('Solução sob medida: 500.000 Kz.', { firedTriggers: ['estimate_request'] })),
  ]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const res = await p.respond(aiRequest({ line: 'custom' }));
  assert.equal(res.reply, null);
  assert.equal(res.answered, false);
  assert.deepEqual(res.firedTriggers, ['estimate_request']);
  assert.equal(calls.length, 1);
});

test('summarizeForHandoff redige turnos e não leva tools', async () => {
  const { transport, calls } = fakeLlm([ok(textResult('Resumo: cliente pediu plano.'))]);
  const { deps } = makeDeps(transport, cfg());
  const p = createLlmAIProvider(deps);
  const out = await p.summarizeForHandoff({
    turns: [{ from: 'customer', text: 'chama-me 912345678' }],
    qualification: { canal: 'whatsapp' },
    reason: 'pedido humano',
  });
  assert.equal(out, 'Resumo: cliente pediu plano.');
  const req = calls[0]!;
  assert.equal(req.tools.length, 0);
  const body = req.messages.map((m) => m.content).join('\n');
  assert.ok(body.includes('[TELEFONE]'));
  assert.ok(!body.includes('912345678'));
});
