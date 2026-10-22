// Fase 3, Task 12: transporte LLM falso com guião de respostas (testes sem rede).
// Repete o último passo quando o guião acaba (útil para 'hang' e repetições).

import { LLMError } from '../../src/adapters/ai/llm-client.js';
import type {
  LLMCallRequest,
  LLMCallResult,
  LLMTransport,
} from '../../src/ports/llm-transport.js';

export type FakeStep =
  | { kind: 'ok'; result: LLMCallResult }
  | { kind: 'err'; error: LLMError }
  | { kind: 'hang' };

export const ok = (result: LLMCallResult): FakeStep => ({ kind: 'ok', result });
export const err = (error: LLMError): FakeStep => ({ kind: 'err', error });
export const hang: FakeStep = { kind: 'hang' };

/** Tool call com um `model` fixo (os testes esperam 'modelo-x') e id determinístico. */
export function toolCallResult(
  name: string,
  args: unknown,
  model = 'modelo-x',
  id = 'call-fake-1',
): LLMCallResult {
  return { content: null, toolCall: { id, name, args }, model };
}

/** Resposta só de texto (sem tool call). */
export function textResult(content: string, model = 'modelo-x'): LLMCallResult {
  return { content, toolCall: null, model };
}

export function fakeLlm(steps: FakeStep[]): {
  transport: LLMTransport;
  calls: LLMCallRequest[];
} {
  const calls: LLMCallRequest[] = [];
  let i = 0;
  const transport: LLMTransport = {
    name: 'fake',
    async call(req: LLMCallRequest): Promise<LLMCallResult> {
      calls.push(req);
      const step = steps[i] ?? steps[steps.length - 1];
      i++;
      if (!step) throw new Error('fake-llm: guião vazio');
      if (step.kind === 'hang') return new Promise<LLMCallResult>(() => {});
      if (step.kind === 'err') throw step.error;
      return step.result;
    },
  };
  return { transport, calls };
}
