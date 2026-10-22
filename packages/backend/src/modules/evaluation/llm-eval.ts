// Fase 3 — modo LLM do eval (docs/05 §8; A3/A11; decisão humana 2026-10-22:
// fornecedor Groq, free tier). Corre cada candidato pelos 80 cenários com o
// AIProvider real, pontua com `evaluate()` (covers = todos os gatilhos, ao
// contrário do baseline que só cobre dois) e mede os `mustNot` com
// `judgeMustNot` sobre as respostas — é o que escolhe o modelo (A3).
//
// Privacidade: o input é EXCLUSIVAMENTE o ficheiro de cenários sintéticos
// (ADR-0002: "benchmark e desenvolvimento só com dados sintéticos"), por isso
// o runner monta o AIConfig com `dataApproved: true` apenas para este contexto.
// O gate da aplicação (`AI_LLM_DATA_APPROVED` no env) não é tocado: continua a
// decidir quando dados de clientes podem ir ao LLM.
//
// Ritmo: `createPacingTransport` espaça TODAS as chamadas (EVAL_PACING_MS,
// ~28 pedidos/min) para caber no free tier (Groq: 30 RPM); o retry/backoff do
// `callWithPolicy` continua a cobrir 429 pontuais.

import type { AIProvider } from '../../ports/ai-provider.js';
import type { LLMCallRequest, LLMCallResult, LLMTransport } from '../../ports/llm-transport.js';
import { EMPTY_EVAL_FIXTURES, buildEvalClassifier, renderEvalBody } from './harness.js';
import {
  evaluate,
  scenarios,
  type Scenario,
  type TriggerCode,
  type TriggerMetrics,
} from './handoff-scenarios.js';
import { judgeMustNot, type MustNotVerdict } from './must-not.js';

export type EvalMode = 'baseline' | 'llm';

/** `--baseline` força o modo sem rede (CI de PR, mesmo com chave no ambiente). */
export function resolveEvalMode(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): EvalMode {
  if (argv.includes('--baseline')) return 'baseline';
  return (env.AI_API_KEY ?? '') !== '' ? 'llm' : 'baseline';
}

/** `AI_CANDIDATES="a,b"` → `[a, b]`; vazio/ausente → `[fallback]` (AI_MODEL). */
export function parseCandidates(raw: string | undefined, fallbackModel: string): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return list.length > 0 ? list : [fallbackModel];
}

/** ~28 pedidos/min — abaixo do limite do Groq free (30 RPM). */
export const EVAL_PACING_MS = 2100;

/**
 * Pacing configurável por `EVAL_PACING_MS` (ms entre chamadas). Existe por
 * evidência: na corrida de 2026-10-22 o candidato qwen levou 69 erros `rate limit`
 * com o default 2100 — em janela partilhada com outra candidata é preciso
 * abrandar sem mudar código. Valor ausente/vazio/inválido → default; `0` desliga.
 */
export function resolvePacingMs(env: Record<string, string | undefined>): number {
  const raw = env['EVAL_PACING_MS'];
  if (raw === undefined || raw.trim() === '') return EVAL_PACING_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return EVAL_PACING_MS;
  return n;
}

/** Decorador que espaça todas as chamadas ao transporte (controlo de RPM). */
export function createPacingTransport(
  inner: LLMTransport,
  sleep: (ms: number) => Promise<void>,
  ms: number = EVAL_PACING_MS,
): LLMTransport {
  return {
    name: inner.name,
    async call(req: LLMCallRequest, signal: AbortSignal): Promise<LLMCallResult> {
      await sleep(ms);
      return inner.call(req, signal);
    },
  };
}

export interface LlmCandidateResult {
  model: string;
  metrics: Record<string, TriggerMetrics>;
  misses: readonly { id: string }[];
  ambiguous: string[];
  mustNot: MustNotVerdict[];
  /** Cenários que falharam no provider (timeout/validação/429 esgotado). */
  errors: { id: string; error: string }[];
  scenarios: number;
}

export interface RunLlmEvalOptions {
  candidates: readonly string[];
  makeProvider: (model: string) => AIProvider;
  /** Por omissão: os 80 cenários. */
  list?: readonly Scenario[];
}

/** Um erro por cenário não aborta a corrida: fica em `errors` e conta como previsão vazia. */
export async function runLlmEval(
  opts: RunLlmEvalOptions,
): Promise<{ candidates: LlmCandidateResult[] }> {
  const list = opts.list ?? scenarios;
  const results: LlmCandidateResult[] = [];

  for (const model of opts.candidates) {
    const classify = buildEvalClassifier(opts.makeProvider(model), EMPTY_EVAL_FIXTURES);
    const predicted = new Map<string, TriggerCode[]>();
    const mustNot: MustNotVerdict[] = [];
    const errors: { id: string; error: string }[] = [];

    for (const s of list) {
      try {
        const r = await classify(s);
        predicted.set(s.id, r.triggers);
        mustNot.push(...judgeMustNot(s, r.reply));
      } catch (caught) {
        predicted.set(s.id, []);
        errors.push({
          id: s.id,
          error: caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
        });
      }
    }

    // Precomputado acima → evaluate() recebe as previsões sem voltar a chamar o provider.
    const scored = await evaluate(list, (s) => predicted.get(s.id) ?? []);
    results.push({
      model,
      metrics: scored.metrics,
      misses: scored.misses,
      ambiguous: scored.ambiguous,
      mustNot,
      errors,
      scenarios: list.length,
    });
  }

  return { candidates: results };
}

const isoDate = (): string => new Date().toISOString().slice(0, 10);

/** Relatório único com tabela comparativa + secção por candidato. */
export function renderLlmEvalReport(results: readonly LlmCandidateResult[]): string {
  const lines: string[] = [];
  lines.push(`# Eval (LLM) — ${isoDate()}`);
  lines.push('');
  lines.push('| model | misses | mustNot | errors |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.model} | ${r.misses.length} | ${r.mustNot.length} | ${r.errors.length} |`);
  }
  for (const r of results) {
    lines.push('');
    lines.push(`## ${r.model}`);
    lines.push('');
    lines.push(renderEvalBody({ ...r, heading: '###' }).trimEnd());
    if (r.errors.length > 0) {
      lines.push('');
      lines.push('### errors');
      for (const e of r.errors) lines.push(`- ${e.id}: ${e.error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
