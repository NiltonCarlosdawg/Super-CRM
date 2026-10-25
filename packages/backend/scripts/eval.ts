// Runner de avaliação — Fase 3, Task 20 + modo LLM (docs/05 §8).
// Modo baseline (`--baseline`, ou simplesmente sem AI_API_KEY): sem rede e sem
// segredos — a rede de segurança por palavras-chave classifica os 80 cenários
// sintéticos → evaluate() → reports/eval-report.md. É o que o CI corre no PR
// (`npm run eval:baseline`). O juiz mustNot fica vazio aqui: o baseline não
// gera texto de resposta.
// Modo LLM (AI_API_KEY presente): candidatos de AI_CANDIDATES (ou AI_MODEL)
// passam pelo AIProvider real — o evaluate() é que escolhe o modelo (A3,
// docs/06) — e o juiz mustNot mede as violações nas respostas (docs/05 §8).
// O gate A11 continua na app: `AI_LLM_DATA_APPROVED` no env mantém-se fechado
// para dados de clientes; este runner só lê cenários sintéticos (ADR-0002)
// e daí montar o provider com `dataApproved: true` próprio deste contexto.
// Segredos: a chave entra só por env (--env-file-if-exists=.env local ou env
// do CI), nunca em código, commits ou logs.
// Correr: npm run eval  |  npm run eval:baseline

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAIConfig } from '../src/adapters/ai/config.js';
import { createLlmAIProvider } from '../src/adapters/ai/llm-ai-provider.js';
import { createTransport } from '../src/adapters/ai/transports/index.js';
import { SAFETY_NET_COVERS, keywordSafetyNet } from '../src/domain/keyword-safety-net.js';
import { renderEvalReport } from '../src/modules/evaluation/harness.js';
import {
  TRIGGER_CODES,
  evaluate,
  scenarios,
  type TriggerCode,
} from '../src/modules/evaluation/handoff-scenarios.js';
import {
  createPacingTransport,
  parseCandidates,
  renderLlmEvalReport,
  resolveEvalMode,
  resolvePacingMs,
  runLlmEval,
} from '../src/modules/evaluation/llm-eval.js';

const reportsDir = join(process.cwd(), 'reports');
mkdirSync(reportsDir, { recursive: true });
const out = join(reportsDir, 'eval-report.md');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const mode = resolveEvalMode(process.argv, process.env);

if (mode === 'llm') {
  // Valida provider/modelo/chave sem ecoar valores (ConfigError lista só nomes).
  const cfg = parseAIConfig(process.env);
  if (!cfg.apiKey) {
    throw new Error('AI_API_KEY: obrigatória para o modo LLM');
  }
  // Input exclusivamente sintético (ADR-0002) — ver cabeçalho: o gate da app
  // (AI_LLM_DATA_APPROVED) não é lido nem alterado aqui.
  const evalCfg = { ...cfg, dataApproved: true };
  const candidates = parseCandidates(process.env.AI_CANDIDATES, cfg.model);

  const makeProvider = (model: string) =>
    createLlmAIProvider({
      transport: createPacingTransport(
        createTransport({ ...evalCfg, model }, fetch),
        sleep,
        resolvePacingMs(process.env),
      ),
      config: { ...evalCfg, model },
      // temperature 0: gate reprodutível entre corridas (decisão 2026-10-25).
      temperature: 0,
      sleep,
      random: Math.random,
      now: () => Date.now(),
    });

  const { candidates: results } = await runLlmEval({ candidates, makeProvider });
  const report = renderLlmEvalReport(results);
  writeFileSync(out, report);

  for (const r of results) {
    console.log(
      `${r.model}: misses=${r.misses.length} mustNot=${r.mustNot.length} ` +
        `errors=${r.errors.length} ambiguous=${r.ambiguous.length}`,
    );
  }
  console.log(`relatório escrito em ${out}`);
} else {
  const result = await evaluate(
    scenarios,
    (s) =>
      keywordSafetyNet(s.turns).filter((c): c is TriggerCode =>
        (TRIGGER_CODES as readonly string[]).includes(c),
      ),
    SAFETY_NET_COVERS,
  );

  // Composição do conjunto: os 4 fechados (nota "Decisão docs/05 §8") e os
  // adversariais ficam em balde próprio — o resto é o par positivos/negativos.
  const isFechado = (s: (typeof scenarios)[number]): boolean =>
    s.note?.startsWith('Decisão docs/05 §8') ?? false;
  const adversarial = scenarios.filter((s) => s.id.startsWith('adv-'));
  const fechados = scenarios.filter(isFechado);
  const rest = scenarios.filter((s) => !s.id.startsWith('adv-') && !isFechado(s));
  const positivos = rest.filter((s) => s.expect.triggers.length > 0).length;

  const report = renderEvalReport({
    model: 'keyword-safety-net',
    metrics: result.metrics,
    misses: result.misses,
    ambiguous: result.ambiguous,
    mustNot: [], // baseline sem respostas: o juiz mustNot corre no modo LLM
    scenarios: scenarios.length,
  });
  writeFileSync(out, report);

  console.log(
    `cenários: ${scenarios.length} — ${positivos} positivos, ${rest.length - positivos} negativos, ` +
      `${fechados.length} fechados, ${adversarial.length} adversariais`,
  );
  console.log('');
  console.log(report);
  console.log(`relatório escrito em ${out}`);
}
