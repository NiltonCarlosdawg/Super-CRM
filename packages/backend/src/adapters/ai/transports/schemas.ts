// Fase 3, Task 7: validação das respostas LLM com zod (formatos documentados em
// README.md). Um corpo malformado ou `arguments` que não é JSON dá `invalid_response`.

import { z } from 'zod';

import type { LLMCallResult } from '../../../ports/llm-transport.js';
import { LLMError } from '../llm-client.js';

type Parsed = Omit<LLMCallResult, 'model'>;

const openAIResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().default(null),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
});

export function parseOpenAIResponse(json: unknown): Parsed {
  const parsed = openAIResponse.safeParse(json);
  if (!parsed.success) throw new LLMError('resposta OpenAI malformada', 'invalid_response');

  const choice = parsed.data.choices[0];
  if (!choice) throw new LLMError('resposta OpenAI sem choices', 'invalid_response');
  const message = choice.message;
  const call = message.tool_calls?.[0];
  if (call) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new LLMError('arguments do tool_call não é JSON válido', 'invalid_response');
    }
    return { content: message.content, toolCall: { id: call.id, name: call.function.name, args } };
  }
  return { content: message.content, toolCall: null };
}

const anthropicBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
]);

const anthropicResponse = z.object({ content: z.array(anthropicBlock) });

export function parseAnthropicResponse(json: unknown): Parsed {
  const parsed = anthropicResponse.safeParse(json);
  if (!parsed.success) throw new LLMError('resposta Anthropic malformada', 'invalid_response');

  const text = parsed.data.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
  const toolUse = parsed.data.content.find((b) => b.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    return { content: text || null, toolCall: { id: toolUse.id, name: toolUse.name, args: toolUse.input } };
  }
  return { content: text || null, toolCall: null };
}
