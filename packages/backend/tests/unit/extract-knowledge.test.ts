// Treinar agente, Task 3: `AIProvider.extractKnowledge` — extração de
// conhecimento da empresa com saída estruturada validada por zod. Todos os
// cenários usam o transporte falso (tests/helpers/fake-llm.ts), sem rede.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIConfig } from '../../src/adapters/ai/config.js';
import { createLlmAIProvider, AIGateError, type LlmProviderDeps } from '../../src/adapters/ai/llm-ai-provider.js';
import { LLMError } from '../../src/adapters/ai/llm-client.js';
import { AIValidationError } from '../../src/adapters/ai/submit-response.js';
import { createUnavailableAiProvider } from '../../src/adapters/ai/unavailable.js';
import type { LLMTransport } from '../../src/ports/llm-transport.js';
import { fakeLlm, ok, textResult, toolCallResult } from '../helpers/fake-llm.js';

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

function makeDeps(transport: LLMTransport, config: AIConfig): LlmProviderDeps {
  return {
    transport,
    config,
    sleep: async () => {},
    random: () => 0.5,
    now: () => 0,
  };
}

const catalogItem = {
  slug: 'pacote-cftv-4-camaras',
  lineSlug: 'cctv',
  op: 'create',
  payload: {
    kind: 'catalog_item',
    name: 'Pacote CFTV 4 câmaras',
    summary: 'Quatro câmaras com instalação incluída.',
    details: { cameras: 4 },
    pricingMode: 'fixed',
    priceAmount: '150000.00',
    // `currency` ausente de propósito: tem de sair 'AOA'.
    priceNote: null,
    availability: 'available',
  },
};

const knowledgeDoc = {
  slug: 'garantia-instalacao',
  lineSlug: null,
  op: 'create',
  payload: {
    kind: 'knowledge_doc',
    docType: 'policy',
    title: 'Garantia da instalação',
    body: 'A instalação tem garantia de 12 meses.',
  },
};

const rule = {
  slug: 'desconto-maximo',
  lineSlug: 'software',
  op: 'update',
  payload: {
    kind: 'rule',
    ruleKind: 'discount_limit',
    title: 'Desconto máximo',
    instruction: 'Nunca conceder mais de 10% sem aprovação.',
    params: { maxDiscountPct: 10 },
  },
};

test('submit_knowledge válido → items normalizados, currency default AOA e slug preservado', async () => {
  const { transport, calls } = fakeLlm([
    ok(toolCallResult('submit_knowledge', { items: [catalogItem, knowledgeDoc, rule] })),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  const result = await provider.extractKnowledge({ text: 'Documento da empresa.' });

  assert.equal(result.items.length, 3);
  const catalog = result.items[0]!.payload;
  assert.equal(catalog.kind, 'catalog_item');
  assert.equal(catalog.currency, 'AOA');
  assert.equal(catalog.pricingMode, 'fixed');
  assert.equal(result.items[0]!.slug, 'pacote-cftv-4-camaras');
  assert.equal(result.items[0]!.lineSlug, 'cctv');
  assert.equal(result.items[1]!.payload.kind, 'knowledge_doc');
  assert.equal(result.items[2]!.payload.kind, 'rule');
  assert.equal(result.items[2]!.op, 'update');

  // Uma única chamada ao transporte, com a tool de extração e o texto do documento.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tools.length, 1);
  assert.equal(calls[0]!.tools[0]!.name, 'submit_knowledge');
  assert.match(calls[0]!.messages[0]!.content, /não inventes preços/);
  assert.equal(calls[0]!.messages[1]!.content, 'Documento da empresa.');
});

test('campos desconhecidos são descartados', async () => {
  const { transport } = fakeLlm([
    ok(
      toolCallResult('submit_knowledge', {
        items: [
          {
            ...catalogItem,
            extra: 'descartar',
            payload: { ...catalogItem.payload, extra: 'descartar' },
          },
        ],
      }),
    ),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  const result = await provider.extractKnowledge({ text: 'x' });

  assert.ok(!('extra' in result.items[0]!));
  assert.ok(!('extra' in result.items[0]!.payload));
});

test('pricingMode inválido → AIValidationError a nomear o campo, sem retry', async () => {
  const { transport, calls } = fakeLlm([
    ok(
      toolCallResult('submit_knowledge', {
        items: [{ ...catalogItem, payload: { ...catalogItem.payload, pricingMode: 'caro' } }],
      }),
    ),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) =>
      e instanceof AIValidationError &&
      /items\.0\.payload\.pricingMode/.test((e as Error).message),
  );
  assert.equal(calls.length, 1);
});

test('pricingMode fixed/from exige priceAmount numérico', async () => {
  const { transport, calls } = fakeLlm([
    ok(
      toolCallResult('submit_knowledge', {
        items: [{ ...catalogItem, payload: { ...catalogItem.payload, priceAmount: null } }],
      }),
    ),
    ok(
      toolCallResult('submit_knowledge', {
        items: [
          {
            ...catalogItem,
            payload: { ...catalogItem.payload, pricingMode: 'from', priceAmount: 'sob consulta' },
          },
        ],
      }),
    ),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) =>
      e instanceof AIValidationError &&
      /items\.0\.payload\.priceAmount/.test((e as Error).message),
  );
  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) => e instanceof AIValidationError,
  );
  assert.equal(calls.length, 2);
});

test('pricingMode quote_only exige priceAmount null', async () => {
  const { transport } = fakeLlm([
    ok(
      toolCallResult('submit_knowledge', {
        items: [{ ...catalogItem, payload: { ...catalogItem.payload, pricingMode: 'quote_only' } }],
      }),
    ),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) =>
      e instanceof AIValidationError &&
      /items\.0\.payload\.priceAmount/.test((e as Error).message),
  );
});

test('quote_only com priceAmount null é aceite', async () => {
  const { transport } = fakeLlm([
    ok(
      toolCallResult('submit_knowledge', {
        items: [
          {
            ...catalogItem,
            payload: { ...catalogItem.payload, pricingMode: 'quote_only', priceAmount: null },
          },
        ],
      }),
    ),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  const result = await provider.extractKnowledge({ text: 'x' });
  const payload = result.items[0]!.payload;
  assert.equal(payload.kind, 'catalog_item');
  assert.equal(payload.priceAmount, null);
});

test('slug fora de kebab-case é rejeitado', async () => {
  const { transport } = fakeLlm([
    ok(toolCallResult('submit_knowledge', { items: [{ ...catalogItem, slug: 'Pacote CFTV' }] })),
  ]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) =>
      e instanceof AIValidationError && /items\.0\.slug/.test((e as Error).message),
  );
});

test('resposta só com texto (sem tool call) → LLMError', async () => {
  const { transport, calls } = fakeLlm([ok(textResult('Aqui está o conhecimento.'))]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg()));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) => e instanceof LLMError && e.kind === 'invalid_response',
  );
  assert.equal(calls.length, 1);
});

test('gate A11 fechado: AIGateError e 0 chamadas', async () => {
  const { transport, calls } = fakeLlm([]);
  const provider = createLlmAIProvider(makeDeps(transport, cfg({ dataApproved: false })));

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) => e instanceof AIGateError,
  );
  assert.equal(calls.length, 0);
});

test('provider indisponível: extractKnowledge rejeita com LLMError ai_unavailable', async () => {
  const provider = createUnavailableAiProvider();

  await assert.rejects(
    provider.extractKnowledge({ text: 'x' }),
    (e: unknown) => e instanceof LLMError && e.message === 'ai_unavailable',
  );
});
