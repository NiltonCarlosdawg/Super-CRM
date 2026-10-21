// Fase 3, Task 7: transporte OpenAI (Chat Completions). Formato documentado em ../README.md.

import type {
  LLMCallRequest,
  LLMCallResult,
  LLMMessage,
  LLMTool,
  LLMTransport,
} from '../../../ports/llm-transport.js';
import { joinUrl, postJson } from './http.js';
import { parseOpenAIResponse } from './schemas.js';

function toMessages(messages: readonly LLMMessage[]): unknown[] {
  return messages.map((m) =>
    m.role === 'tool'
      ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      : { role: m.role, content: m.content },
  );
}

function toTools(tools: readonly LLMTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function buildBody(req: LLMCallRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toMessages(req.messages),
    max_completion_tokens: req.maxTokens,
  };
  if (req.tools.length > 0) body.tools = toTools(req.tools);
  return body;
}

export function createOpenAITransport(deps: {
  baseUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
}): LLMTransport {
  const url = joinUrl(deps.baseUrl, '/v1/chat/completions');
  return {
    name: 'openai',
    async call(req: LLMCallRequest, signal: AbortSignal): Promise<LLMCallResult> {
      const json = await postJson(
        url,
        { Authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
        buildBody(req),
        deps.fetch,
        signal,
      );
      const { content, toolCall } = parseOpenAIResponse(json);
      return { content, toolCall, model: req.model };
    },
  };
}
