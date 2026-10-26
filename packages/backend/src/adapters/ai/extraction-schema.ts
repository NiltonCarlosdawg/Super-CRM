// Treinar agente, Task 3: ferramenta `submit_knowledge` — espelho zod dos tipos
// `ExtractedItem`/`ExtractedPayload` (ports/ai-provider.ts). Os campos
// desconhecidos são descartados; um arg inválido lança `AIValidationError` a
// nomear o campo (mesma semântica de `submit_response`). Regra dura: `fixed` e
// `from` exigem um preço numérico explícito; `quote_only` exige `null` — nunca
// se inventa um preço a partir de texto livre.

import { z } from 'zod';

import type { ExtractedItem } from '../../ports/ai-provider.js';
import type { LLMTool } from '../../ports/llm-transport.js';
import { AIValidationError } from './submit-response.js';

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const priceAmountSchema = z.string().regex(/^\d+(\.\d{1,2})?$/);
const lineSlugSchema = z.enum(['software', 'custom', 'telecom', 'cctv']);

const catalogPayloadSchema = z
  .object({
    kind: z.literal('catalog_item'),
    name: z.string(),
    summary: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    pricingMode: z.enum(['fixed', 'from', 'quote_only']),
    priceAmount: z.string().nullable(),
    currency: z.string().default('AOA'),
    priceNote: z.string().nullable(),
    availability: z.enum(['available', 'limited', 'unavailable']),
  })
  .superRefine((value, ctx) => {
    if (value.pricingMode === 'quote_only') {
      if (value.priceAmount !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['priceAmount'],
          message: 'quote_only exige priceAmount null',
        });
      }
      return;
    }
    if (value.priceAmount === null || !priceAmountSchema.safeParse(value.priceAmount).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceAmount'],
        message: 'fixed/from exigem priceAmount numérico (ex.: "150000.00")',
      });
    }
  });

const knowledgeDocPayloadSchema = z.object({
  kind: z.literal('knowledge_doc'),
  docType: z.enum(['faq', 'policy', 'process', 'company_info', 'objection']),
  title: z.string(),
  body: z.string(),
});

const rulePayloadSchema = z.object({
  kind: z.literal('rule'),
  ruleKind: z.enum(['may_promise', 'must_not_claim', 'discount_limit', 'payment_terms', 'tone']),
  title: z.string(),
  instruction: z.string(),
  params: z.record(z.string(), z.unknown()).nullable(),
});

const extractedItemSchema = z.object({
  slug: slugSchema,
  lineSlug: lineSlugSchema.nullable(),
  op: z.enum(['create', 'update']),
  payload: z.discriminatedUnion('kind', [
    catalogPayloadSchema,
    knowledgeDocPayloadSchema,
    rulePayloadSchema,
  ]),
});

export const extractedKnowledgeSchema = z.object({
  items: z.array(extractedItemSchema),
});

export interface ExtractedKnowledgeOutput {
  items: ExtractedItem[];
}

export function parseExtractedKnowledge(args: unknown): ExtractedKnowledgeOutput {
  const result = extractedKnowledgeSchema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : '(raiz)';
    throw new AIValidationError(`submit_knowledge inválido no campo '${field}'`);
  }
  return result.data;
}

export const EXTRACT_KNOWLEDGE_TOOL: LLMTool = {
  name: 'submit_knowledge',
  description:
    'Submete o conhecimento extraído do documento da empresa. Usa sempre esta ferramenta.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Itens de conhecimento explícitos no documento.',
        items: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              description: 'Identidade estável em kebab-case (ex.: pacote-cftv-4-camaras).',
            },
            lineSlug: {
              type: ['string', 'null'],
              enum: ['software', 'custom', 'telecom', 'cctv', null],
              description: 'Linha de negócio proposta; null se não for clara.',
            },
            op: {
              type: 'string',
              enum: ['create', 'update'],
              description: 'create para conhecimento novo; update para corrigir um item existente.',
            },
            payload: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['catalog_item'] },
                    name: { type: 'string' },
                    summary: { type: 'string' },
                    details: { type: ['object', 'null'], additionalProperties: true },
                    pricingMode: { type: 'string', enum: ['fixed', 'from', 'quote_only'] },
                    priceAmount: {
                      type: ['string', 'null'],
                      description:
                        'Valor numérico explícito (ex.: "150000.00") em fixed/from; null em quote_only.',
                    },
                    currency: {
                      type: 'string',
                      description: 'Moeda ISO 4217; omite para usar AOA.',
                    },
                    priceNote: { type: ['string', 'null'] },
                    availability: {
                      type: 'string',
                      enum: ['available', 'limited', 'unavailable'],
                    },
                  },
                  required: [
                    'kind',
                    'name',
                    'summary',
                    'details',
                    'pricingMode',
                    'priceAmount',
                    'priceNote',
                    'availability',
                  ],
                },
                {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['knowledge_doc'] },
                    docType: {
                      type: 'string',
                      enum: ['faq', 'policy', 'process', 'company_info', 'objection'],
                    },
                    title: { type: 'string' },
                    body: { type: 'string' },
                  },
                  required: ['kind', 'docType', 'title', 'body'],
                },
                {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['rule'] },
                    ruleKind: {
                      type: 'string',
                      enum: [
                        'may_promise',
                        'must_not_claim',
                        'discount_limit',
                        'payment_terms',
                        'tone',
                      ],
                    },
                    title: { type: 'string' },
                    instruction: { type: 'string' },
                    params: { type: ['object', 'null'], additionalProperties: true },
                  },
                  required: ['kind', 'ruleKind', 'title', 'instruction', 'params'],
                },
              ],
            },
          },
          required: ['slug', 'lineSlug', 'op', 'payload'],
        },
      },
    },
    required: ['items'],
  },
};
