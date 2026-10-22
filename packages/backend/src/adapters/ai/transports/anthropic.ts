// Fase 3, Task 7: transporte Anthropic (Messages). Formato documentado em ../README.md.
// O system prompt vai no campo `system` (role "system" não existe nas messages).

import type {
  LLMCallRequest,
  LLMCallResult,
  LLMMessage,
  LLMTool,
  LLMTransport,
} from '../../../ports/llm-transport.js';
import { joinUrl, postJson } from './http.js';
import { parseAnthropicResponse } from './schemas.js';

function toMessage(m: LLMMessage): unknown {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
    };
  }
  if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) {
    // Ecoa os blocos tool_use com o id recebido — obrigatório antes do tool_result.
    const blocks: unknown[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
    return { role: 'assistant', content: blocks };
  }
  return { role: m.role, content: m.content };
}

function toTools(tools: readonly LLMTool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function buildBody(req: LLMCallRequest): Record<string, unknown> {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages.filter((m) => m.role !== 'system').map(toMessage),
  };
  if (system) body.system = system;
  if (req.tools.length > 0) body.tools = toTools(req.tools);
  return body;
}

export function createAnthropicTransport(deps: {
  baseUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
}): LLMTransport {
  const url = joinUrl(deps.baseUrl, '/v1/messages');
  return {
    name: 'anthropic',
    async call(req: LLMCallRequest, signal: AbortSignal): Promise<LLMCallResult> {
      const json = await postJson(
        url,
        {
          'x-api-key': deps.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        buildBody(req),
        deps.fetch,
        signal,
      );
      const { content, toolCall } = parseAnthropicResponse(json);
      return { content, toolCall, model: req.model };
    },
  };
}
