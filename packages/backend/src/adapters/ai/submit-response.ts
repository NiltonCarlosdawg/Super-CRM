// Fase 3, Task 9: ferramenta `submit_response` — saída estruturada do modelo
// validada com zod (docs/05 §6). Os campos desconhecidos são descartados; um arg
// inválido lança `AIValidationError` a nomear o campo (o orquestrador envia
// `SUBMIT_RETRY_NOTE` de volta para o modelo corrigir).

import { z } from 'zod';

import type { LLMTool } from '../../ports/llm-transport.js';

export const SUBMIT_RESPONSE_TOOL: LLMTool = {
  name: 'submit_response',
  description: 'Submete a tua resposta ao cliente com saída estruturada. Usa sempre esta ferramenta.',
  inputSchema: {
    type: 'object',
    properties: {
      reply: {
        type: ['string', 'null'],
        description: 'Texto para o cliente. null se não há nada fiável para dizer.',
      },
      answered: {
        type: 'boolean',
        description: 'false se não havia fonte fiável no conhecimento (lacuna).',
      },
      firedTriggers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Códigos de gatilho de handoff reconhecidos na mensagem.',
      },
      qualificationUpdates: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Respostas de qualificação extraídas (key -> valor).',
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['chunk', 'catalog', 'rule'] },
            id: { type: 'string' },
            version: { type: 'number' },
          },
          required: ['type', 'id'],
        },
        description: 'Fontes realmente usadas na resposta.',
      },
    },
    required: ['reply', 'answered', 'firedTriggers', 'qualificationUpdates', 'sources'],
  },
};

export interface SubmitResponseOutput {
  reply: string | null;
  answered: boolean;
  firedTriggers: string[];
  qualificationUpdates: Record<string, string>;
  sources: { type: 'chunk' | 'catalog' | 'rule'; id: string; version?: number }[];
}

export class AIValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIValidationError';
  }
}

const sourceSchema = z.object({
  type: z.enum(['chunk', 'catalog', 'rule']),
  id: z.string(),
  version: z.number().optional(),
});

const submitSchema = z.object({
  reply: z.string().nullable(),
  answered: z.boolean(),
  firedTriggers: z.array(z.string()),
  qualificationUpdates: z.record(z.string(), z.string()),
  sources: z.array(sourceSchema),
});

export const SUBMIT_RETRY_NOTE =
  'Chamada a submit_response inválida. Corrige e volta a chamá-la.';

export function parseSubmitResponse(args: unknown): SubmitResponseOutput {
  const r = submitSchema.safeParse(args);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(raiz)';
    throw new AIValidationError(`submit_response inválido no campo '${field}'`);
  }
  return r.data;
}
