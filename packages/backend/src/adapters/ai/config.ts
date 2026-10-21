// Fase 3, Task 5: configuração da IA validada no arranque (docs/05 §6, A11).
// As variáveis entram por `env` (testável), nunca `process.env` espalhado. O gate
// A11 (`AI_LLM_DATA_APPROVED`, false por omissão) decide se dados de clientes
// podem ir para um LLM externo; só quando aberto é que `AI_API_KEY` é obrigatória.
// Mensagens de erro listam o NOME da variável, nunca o valor (segredos AGENTS.md §4).

import { z } from 'zod';

import { ConfigError } from '../../infra/config.js';

export interface AIConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  timeoutMs: number; // AI_TIMEOUT_MS, default 20000
  maxRetries: number; // AI_MAX_RETRIES, default 2
  maxTokens: number; // AI_MAX_TOKENS, default 1024
  historyTurns: number; // AI_HISTORY_TURNS, default 10
  retrievalTopK: number; // AI_RETRIEVAL_TOP_K, default 5
  retrievalMinSimilarity: number; // RETRIEVAL_MIN_SIMILARITY, default 0.75
  missStreakLimit: number; // MISS_STREAK_LIMIT, default 2
  dataApproved: boolean; // AI_LLM_DATA_APPROVED, default false (gate A11)
}

const AI_VARS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_TIMEOUT_MS',
  'AI_MAX_RETRIES',
  'AI_MAX_TOKENS',
  'AI_HISTORY_TURNS',
  'AI_RETRIEVAL_TOP_K',
  'AI_RETRIEVAL_MIN_SIMILARITY',
  'AI_MISS_STREAK_LIMIT',
  'AI_LLM_DATA_APPROVED',
] as const;

const aiSchema = z.object({
  AI_PROVIDER: z.enum(['openai', 'anthropic']),
  AI_MODEL: z.string().min(1),
  AI_BASE_URL: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  AI_HISTORY_TURNS: z.coerce.number().int().nonnegative().default(10),
  AI_RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(5),
  AI_RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.75),
  AI_MISS_STREAK_LIMIT: z.coerce.number().int().positive().default(2),
  AI_LLM_DATA_APPROVED: z.string().optional(),
});

/** '' conta como ausente (igual a config.ts da Fase 0). */
function pickAI(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const key of AI_VARS) raw[key] = env[key] === '' ? undefined : env[key];
  return raw;
}

/** Lê e valida a config da IA. Lança `ConfigError` sem ecoar valores. */
export function parseAIConfig(env: Record<string, string | undefined>): AIConfig {
  const dataApproved = env.AI_LLM_DATA_APPROVED === 'true';
  const result = aiSchema.safeParse(pickAI(env));

  if (!result.success) {
    const failed = new Set(result.error.issues.map((i) => String(i.path?.[0])));
    const issues = AI_VARS.filter((k) => failed.has(k)).map((k) => `${k}: valor inválido ou em falta`);
    throw new ConfigError(issues);
  }

  // Gate A11: chave obrigatória só quando os dados estão aprovados para o LLM.
  if (dataApproved && !result.data.AI_API_KEY) {
    throw new ConfigError(['AI_API_KEY: obrigatória quando AI_LLM_DATA_APPROVED=true']);
  }

  const d = result.data;
  return {
    provider: d.AI_PROVIDER,
    model: d.AI_MODEL,
    baseUrl: d.AI_BASE_URL ?? null,
    apiKey: d.AI_API_KEY ?? null,
    timeoutMs: d.AI_TIMEOUT_MS,
    maxRetries: d.AI_MAX_RETRIES,
    maxTokens: d.AI_MAX_TOKENS,
    historyTurns: d.AI_HISTORY_TURNS,
    retrievalTopK: d.AI_RETRIEVAL_TOP_K,
    retrievalMinSimilarity: d.AI_RETRIEVAL_MIN_SIMILARITY,
    missStreakLimit: d.AI_MISS_STREAK_LIMIT,
    dataApproved,
  };
}
