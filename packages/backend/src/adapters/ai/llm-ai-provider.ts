// Fase 3, Task 12: AIProvider real — composição das Tasks 5–11 (docs/05 §6).
// Fluxo: gate A11 → buildMessages (redação incluída) → loop de tools
// (lookup_catalog → runCatalogLookup; submit_response → parse + guardas).
// Um submit_response inválido ou ausente leva a 1 repetição com SUBMIT_RETRY_NOTE;
// se falhar de novo → AIValidationError. Toda a fala com o LLM passa por
// `callWithPolicy` (retry só em rate_limit/server).

import { allowedSourceIds, applyBlockingGuards, filterSources } from '../../domain/guards.js';
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  CatalogFact,
  Turn,
} from '../../ports/ai-provider.js';
import type { LLMCallRequest, LLMMessage, LLMTool, LLMTransport } from '../../ports/llm-transport.js';
import {
  discountRejectedHint,
  LOOKUP_CATALOG_TOOL,
  runCatalogLookup,
} from './catalog-tool.js';
import type { AIConfig } from './config.js';
import {
  callWithPolicy,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from './llm-client.js';
import { buildMessages } from './prompt.js';
import {
  AIValidationError,
  parseSubmitResponse,
  SUBMIT_RETRY_NOTE,
  SUBMIT_RESPONSE_TOOL,
} from './submit-response.js';

export const MAX_TOOL_CALLS = 4;

export class AIGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIGateError';
  }
}

export interface LlmProviderDeps {
  transport: LLMTransport;
  config: AIConfig;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

export function createLlmAIProvider(deps: LlmProviderDeps): AIProvider {
  const { transport, config } = deps;
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    sleep: deps.sleep,
    random: deps.random,
  };
  const tools: LLMTool[] = [LOOKUP_CATALOG_TOOL, SUBMIT_RESPONSE_TOOL];

  function gate(): void {
    if (!config.dataApproved) {
      throw new AIGateError('AI_LLM_DATA_APPROVED=false: dados não aprovados para o LLM');
    }
  }

  async function respond(req: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    gate();
    const start = deps.now();
    let messages: LLMMessage[] = buildMessages(req, config);
    const catalogFacts: CatalogFact[] = [];
    const catalogPrices: string[] = [];
    let toolCalls = 0;
    let submitAttempts = 0;

    for (;;) {
      const request: LLMCallRequest = {
        model: config.model,
        messages,
        tools,
        maxTokens: config.maxTokens,
      };
      const result = await callWithPolicy(transport, request, policy, signal);
      const call = result.toolCall;

      if (call && call.name === 'submit_response') {
        try {
          const out = parseSubmitResponse(call.args);
          const allowed = allowedSourceIds(req, catalogFacts);
          const filtered = filterSources(out.sources, allowed);
          const guarded = applyBlockingGuards({
            line: req.line,
            reply: out.reply ?? '',
            answered: out.answered,
            sources: filtered,
            catalogPrices,
          });
          const blocked = guarded.blocked.length > 0;
          return {
            reply: blocked ? null : out.reply,
            answered: guarded.answered,
            firedTriggers: out.firedTriggers,
            qualificationUpdates: out.qualificationUpdates,
            sources: blocked ? [] : filtered,
            model: result.model,
            latencyMs: deps.now() - start,
          };
        } catch (caught) {
          if (!(caught instanceof AIValidationError)) throw caught;
          submitAttempts += 1;
          if (submitAttempts >= 2) throw caught;
          messages = [...messages, { role: 'user', content: SUBMIT_RETRY_NOTE }];
          continue;
        }
      }

      if (call && call.name === 'lookup_catalog') {
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS) {
          throw new AIValidationError('excedido o máximo de tools sem submit_response');
        }
        const raw = call.args;
        const args = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        const query = typeof args.query === 'string' ? args.query : '';
        const discountPct = typeof args.discountPct === 'number' ? args.discountPct : undefined;
        const r = await runCatalogLookup({
          query,
          discountPct,
          rules: req.rules,
          lookup: (q) => req.lookupCatalog(q),
        });
        let toolText: string;
        if (r.ok) {
          catalogFacts.push(...r.facts);
          for (const f of r.facts) {
            if (f.priceAmount !== null) catalogPrices.push(f.priceAmount);
          }
          toolText = JSON.stringify(r.facts);
        } else {
          toolText = discountRejectedHint(r.capPct);
        }
        messages = [
          ...messages,
          { role: 'assistant', content: result.content ?? '' },
          { role: 'tool', content: toolText, toolCallId: `lookup-${toolCalls}`, toolName: 'lookup_catalog' },
        ];
        continue;
      }

      // sem tool call ou tool desconhecido → ausência de submit_response
      submitAttempts += 1;
      if (submitAttempts >= 2) throw new AIValidationError(SUBMIT_RETRY_NOTE);
      messages = [...messages, { role: 'user', content: SUBMIT_RETRY_NOTE }];
      continue;
    }
  }

  async function summarizeForHandoff(
    input: {
      turns: readonly Turn[];
      qualification: Readonly<Record<string, string>>;
      reason: string;
    },
    signal?: AbortSignal,
  ): Promise<string> {
    gate();
    const minimal: AIRequest = {
      conversationId: '',
      line: null,
      turns: input.turns,
      chunks: [],
      rules: [],
      qualification: { questions: [], answers: { ...input.qualification } },
      triggers: [],
      lookupCatalog: async () => [],
      mode: 'draft',
    };
    const msgs = buildMessages(minimal, config); // [persona-system, turnos redigidos]
    const summarySystem = `Resume a conversa para passar a um humano. Motivo: ${input.reason}. Qualificação: ${JSON.stringify(input.qualification)}. Responde só com texto.`;
    const messages: LLMMessage[] = [{ role: 'system', content: summarySystem }, ...msgs.slice(1)];
    const request: LLMCallRequest = {
      model: config.model,
      messages,
      tools: [],
      maxTokens: config.maxTokens,
    };
    const result = await callWithPolicy(transport, request, policy, signal);
    return result.content ?? '';
  }

  return { respond, summarizeForHandoff };
}
