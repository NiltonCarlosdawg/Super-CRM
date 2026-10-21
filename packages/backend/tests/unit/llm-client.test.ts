// Fase 3, Task 6: política de timeout/retry do transporte LLM (docs/05 §6).
// Transporte falso, sem rede. Retry só em rate_limit/server; timeout/client nunca.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callWithPolicy,
  DEFAULT_RETRY_POLICY,
  LLMError,
} from '../../src/adapters/ai/llm-client.js';
import type {
  LLMCallRequest,
  LLMCallResult,
  LLMTransport,
} from '../../src/ports/llm-transport.js';

const OK: LLMCallResult = { content: 'ok', toolCall: null, model: 'm' };
const REQ: LLMCallRequest = {
  model: 'm',
  messages: [{ role: 'user', content: 'oi' }],
  tools: [],
  maxTokens: 100,
};

function policy(sleeps: number[], overrides: Partial<Parameters<typeof callWithPolicy>[2]> = {}) {
  return {
    ...DEFAULT_RETRY_POLICY,
    sleep: async (ms: number) => void sleeps.push(ms),
    random: () => 0.5,
    ...overrides,
  };
}

test('429 depois 200: duas chamadas, atraso exato 1250 ms', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const t: LLMTransport = {
    name: 'fake',
    call: async () => {
      calls.push('c');
      if (calls.length === 1) throw new LLMError('429', 'rate_limit', 429);
      return OK;
    },
  };
  await callWithPolicy(t, REQ, policy(sleeps));
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1250]); // 1000 * 2^0 + 0.5 * 500
});

test('500, 500, 200: três chamadas e atrasos 1250 e 2250', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const t: LLMTransport = {
    name: 'fake',
    call: async () => {
      calls.push('c');
      if (calls.length <= 2) throw new LLMError('500', 'server', 500);
      return OK;
    },
  };
  await callWithPolicy(t, REQ, policy(sleeps));
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1250, 2250]); // 1000*1+250, 1000*2+250
});

test('400 não repete', async () => {
  const calls: string[] = [];
  const t: LLMTransport = {
    name: 'fake',
    call: async () => {
      calls.push('c');
      throw new LLMError('400', 'client', 400);
    },
  };
  await assert.rejects(
    callWithPolicy(t, REQ, policy([], { sleep: async () => {} })),
    (e: LLMError) => e.kind === 'client',
  );
  assert.equal(calls.length, 1);
});

test('esgota maxRetries=2: 3 chamadas e 2 atrasos', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const t: LLMTransport = {
    name: 'fake',
    call: async () => {
      calls.push('c');
      throw new LLMError('429', 'rate_limit', 429);
    },
  };
  await assert.rejects(
    callWithPolicy(t, REQ, policy(sleeps, { maxRetries: 2 })),
    (e: LLMError) => e.kind === 'rate_limit',
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1250, 2250]);
});

test('timeout por tentativa não repete', async () => {
  const calls: string[] = [];
  const t: LLMTransport = {
    name: 'fake',
    call: () => {
      calls.push('c');
      return new Promise<LLMCallResult>(() => {}); // pendurado
    },
  };
  await assert.rejects(
    callWithPolicy(t, REQ, policy([], { timeoutMs: 20, sleep: async () => {} })),
    (e: LLMError) => e.kind === 'timeout',
  );
  assert.equal(calls.length, 1);
});

test('abort durante o backoff não faz a 3.ª chamada', async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  const t: LLMTransport = {
    name: 'fake',
    call: async () => {
      calls.push('c');
      throw new LLMError('429', 'rate_limit', 429);
    },
  };
  let sleepCount = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    sleepCount++;
    if (sleepCount === 2) controller.abort();
  };
  await assert.rejects(
    callWithPolicy(t, REQ, { ...policy(sleeps, { sleep }), }, controller.signal),
    (e: LLMError) => e.kind === 'client',
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1250, 2250]);
});
