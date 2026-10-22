// Runner de avaliação — Fase 3, Task 20 (docs/05 §8).
// Modo baseline (sem rede, sem segredos): a rede de segurança por palavras-chave
// classifica os 80 cenários sintéticos → evaluate() → relatório em
// reports/eval-report.md. O juiz mustNot fica vazio aqui (o baseline não gera
// texto de resposta) — as violações medem-se no modo LLM.
// Modo LLM (buildEvalClassifier + fornecedor real) fica para quando houver
// fornecedor/chave aprovados (gate A11, ADR-0002) — decisão da Task 20.
// Correr: npm run eval  |  npm run eval:baseline

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFETY_NET_COVERS, keywordSafetyNet } from '../src/domain/keyword-safety-net.js';
import {
  TRIGGER_CODES,
  evaluate,
  scenarios,
  type TriggerCode,
} from '../src/modules/evaluation/handoff-scenarios.js';
import { renderEvalReport } from '../src/modules/evaluation/harness.js';

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

const reportsDir = join(process.cwd(), 'reports');
mkdirSync(reportsDir, { recursive: true });
const out = join(reportsDir, 'eval-report.md');
writeFileSync(out, report);

console.log(
  `cenários: ${scenarios.length} — ${positivos} positivos, ${rest.length - positivos} negativos, ` +
    `${fechados.length} fechados, ${adversarial.length} adversariais`,
);
console.log('');
console.log(report);
console.log(`relatório escrito em ${out}`);
