// Fase 3, Task 20 (docs/05 §8): harness de avaliação.
//  - buildEvalClassifier: monta o AIRequest sintético por cenário e chama o
//    AIProvider real (modo LLM — gate A11; o runner atual é o baseline).
//  - renderEvalReport: relatório markdown (reports/eval-report.md).
// Fixtures: o repo não tem seeds de chunks/questões/regras/catálogo (o único
// seed de conteúdo é triggerSeeds) — decisão Task 20: fixtures VAZIAS; `line`
// e `retrieval` dos cenários são contexto puro. Nada de conteúdo inventado
// (AGENTS.md §3); quando o conteúdo publicado existir, preenchem-se as fixtures.

import type {
  AIProvider,
  AIRequest,
  CatalogFact,
  LineSlug,
  QualificationQuestion,
  RetrievedChunk,
  RuleDef,
} from '../../ports/ai-provider.js';
import { triggerSeeds } from '../knowledge/handoff-triggers.seed.js';
import {
  TRIGGER_CODES,
  type Scenario,
  type TriggerCode,
  type TriggerMetrics,
} from './handoff-scenarios.js';
import type { MustNotVerdict } from './must-not.js';

export interface EvalReply {
  triggers: TriggerCode[];
  reply: string;
}

export interface EvalFixtures {
  chunksByScenario: Record<string, RetrievedChunk[]>; // retrieval 'found' → 1 chunk sintético; 'none_*' → []
  questionsByLine: Record<LineSlug, QualificationQuestion[]>;
  answersWhenComplete: Record<string, string>;
  rules: RuleDef[];
  catalogByLine: Record<LineSlug | 'global', CatalogFact[]>; // software/telecom: fixed; custom/cctv: quote_only
}

export const EMPTY_EVAL_FIXTURES: EvalFixtures = {
  chunksByScenario: {},
  questionsByLine: { software: [], custom: [], telecom: [], cctv: [] },
  answersWhenComplete: {},
  rules: [],
  catalogByLine: { software: [], custom: [], telecom: [], cctv: [], global: [] },
};

// Triggers do seed (globais + por linha) — a única fonte real de TriggerDef.
const seedTriggers = triggerSeeds.map((t) => ({
  id: `seed:${t.lineSlug ?? 'global'}:${t.code}`,
  code: t.code,
  lineSlug: t.lineSlug,
  description: t.description,
  detectionHint: t.detectionHint,
  action: t.action ?? 'handoff_now', // defaults da coluna (schema) — só para o tipo; seeds definem sempre
  priority: t.priority ?? 'normal',
}));

export function buildEvalClassifier(
  provider: AIProvider,
  fixtures: EvalFixtures,
): (s: Scenario) => Promise<EvalReply> {
  return async (s: Scenario): Promise<EvalReply> => {
    const questions = s.line ? fixtures.questionsByLine[s.line] : [];
    const answers: Record<string, string> =
      s.context?.qualification === 'complete'
        ? Object.fromEntries(questions.map((q) => [q.key, fixtures.answersWhenComplete[q.key] ?? '']))
        : {};
    const req: AIRequest = {
      conversationId: `eval:${s.id}`,
      line: s.line,
      turns: s.turns,
      chunks: fixtures.chunksByScenario[s.id] ?? [],
      rules: fixtures.rules,
      qualification: { questions, answers },
      triggers: seedTriggers.filter((t) => t.lineSlug === null || t.lineSlug === s.line),
      lookupCatalog: async () => fixtures.catalogByLine[s.line ?? 'global'],
      mode: 'send',
    };
    const r = await provider.respond(req);
    // Só códigos do conjunto de avaliação entram (o resto não é pontuável).
    const fired = r.firedTriggers.filter((c): c is TriggerCode =>
      (TRIGGER_CODES as readonly string[]).includes(c),
    );
    return { triggers: fired, reply: r.reply ?? '' };
  };
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

export function renderEvalReport(input: {
  model: string;
  metrics: Record<string, TriggerMetrics>;
  misses: readonly { id: string }[];
  ambiguous: string[];
  mustNot: MustNotVerdict[];
  scenarios: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Eval — ${input.model} — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('| trigger | tp | fp | fn | precision | recall |');
  lines.push('|---|---|---|---|---|---|');
  for (const [code, m] of Object.entries(input.metrics)) {
    lines.push(`| ${code} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} |`);
  }
  lines.push('');
  lines.push('## Misses');
  if (input.misses.length === 0) lines.push('(nenhum)');
  else for (const m of input.misses) lines.push(`- ${m.id}`);
  lines.push('');
  lines.push('## Ambiguous');
  if (input.ambiguous.length === 0) lines.push('(nenhum)');
  else for (const a of input.ambiguous) lines.push(`- ${a}`);
  lines.push('');
  lines.push('## mustNot violations');
  if (input.mustNot.length === 0) lines.push('(nenhum)');
  else for (const v of input.mustNot) lines.push(`- ${v.id}: ${v.behavior} — ${JSON.stringify(v.reply)}`);
  lines.push('');
  lines.push(`Scenarios: ${input.scenarios} (base 72 + adversariais 8)`);
  return `${lines.join('\n')}\n`;
}
