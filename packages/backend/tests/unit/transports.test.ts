// Fase 3, Task 7: transportes OpenAI/Anthropic contra fixtures gravadas da
// documentação oficial (sem rede). Ver src/adapters/ai/README.md para a evidência.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LLMError } from '../../src/adapters/ai/llm-client.js';
import { createAnthropicTransport } from '../../src/adapters/ai/transports/anthropic.js';
import { createOpenAITransport } from '../../src/adapters/ai/transports/openai.js';
import type { LLMCallRequest } from '../../src/ports/llm-transport.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(dir, '../fixtures/llm', name), 'utf8')) as T;
}

interface Capture {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeFetch(response: unknown, capture: Capture): typeof globalThis.fetch {
  return (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    capture.url = String(url);
    capture.headers = { ...init?.headers };
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

const OPENAI_TEXT = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
const ANTHROPIC_TEXT = { content: [{ type: 'text', text: 'ok' }] };

type ReqFixture = {
  model: string;
  messages: { role: string; content: string }[];
  max_completion_tokens?: number;
  max_tokens?: number;
  system?: string;
  tools: Record<string, unknown>[];
};

test('openai: corpo do pedido corresponde ao documentado e a msg é verbatim', async () => {
  const f = fixture<ReqFixture>('openai-request.json');
  const capture: Capture = {};
  const req: LLMCallRequest = {
    model: f.model,
    messages: f.messages.map((m) => ({ role: m.role as 'system' | 'user', content: m.content })),
    tools: f.tools.map((t) => {
      const fn = t.function as { name: string; description: string; parameters: Record<string, unknown> };
      return { name: fn.name, description: fn.description, inputSchema: fn.parameters };
    }),
    maxTokens: f.max_completion_tokens ?? 0,
  };
  const t = createOpenAITransport({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    fetch: fakeFetch(OPENAI_TEXT, capture),
  });
  await t.call(req, new AbortController().signal);

  assert.equal(capture.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capture.headers?.['Authorization'], 'Bearer sk-test');
  assert.deepEqual(capture.body, f); // subconjunto documentado, conteúdo verbatim
  assert.equal(req.messages[0].content, (capture.body?.messages as { content: string }[])[0].content);
});

test('anthropic: system é top-level verbatim e tools usam input_schema', async () => {
  const f = fixture<ReqFixture>('anthropic-request.json');
  const capture: Capture = {};
  const req: LLMCallRequest = {
    model: f.model,
    messages: [
      { role: 'system', content: f.system ?? '' },
      ...f.messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ],
    tools: f.tools.map((t) => ({
      name: t.name as string,
      description: t.description as string,
      inputSchema: t.input_schema as Record<string, unknown>,
    })),
    maxTokens: f.max_tokens ?? 0,
  };
  const t = createAnthropicTransport({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    fetch: fakeFetch(ANTHROPIC_TEXT, capture),
  });
  await t.call(req, new AbortController().signal);

  assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capture.headers?.['x-api-key'], 'sk-ant-test');
  assert.equal(capture.headers?.['anthropic-version'], '2023-06-01');
  assert.deepEqual(capture.body, f);
  assert.equal(req.messages[0].content, capture.body?.system);
});

test('openai tool call: arguments JSON string vira toolCall/args', async () => {
  const capture: Capture = {};
  const t = createOpenAITransport({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    fetch: fakeFetch(fixture('openai-tool-call.json'), capture),
  });
  const req: LLMCallRequest = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [],
    maxTokens: 100,
  };
  const result = await t.call(req, new AbortController().signal);
  assert.ok(result.toolCall);
  assert.equal(result.toolCall.name, 'submit_response');
  assert.equal((result.toolCall.args as { cidade?: string }).cidade, 'Luanda');
});

test('anthropic tool use: input objeto vira toolCall/args', async () => {
  const capture: Capture = {};
  const t = createAnthropicTransport({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    fetch: fakeFetch(fixture('anthropic-tool-call.json'), capture),
  });
  const req: LLMCallRequest = {
    model: 'claude-3-5-sonnet-latest',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [],
    maxTokens: 100,
  };
  const result = await t.call(req, new AbortController().signal);
  assert.ok(result.toolCall);
  assert.equal(result.toolCall.name, 'submit_response');
  assert.equal((result.toolCall.args as { cidade?: string }).cidade, 'Luanda');
});

test('openai arguments inválido → invalid_response', async () => {
  const t = createOpenAITransport({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    fetch: fakeFetch(fixture('openai-invalid-args.json'), {}),
  });
  const req: LLMCallRequest = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [],
    maxTokens: 100,
  };
  await assert.rejects(
    t.call(req, new AbortController().signal),
    (e: LLMError) => e.kind === 'invalid_response',
  );
});
