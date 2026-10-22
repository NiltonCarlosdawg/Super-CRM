// Runner da avaliação — rede de segurança por palavras-chave. Correr com: npm run eval
// Classifica os 80 cenários sintéticos de src/modules/evaluation/handoff-scenarios.ts
// com a função pura keywordSafetyNet (só os gatilhos cobertos) e imprime o
// relatório de docs/05 §8 (Task 19: 4 fechados + 8 adversariais).

import { SAFETY_NET_COVERS, keywordSafetyNet } from '../../src/domain/keyword-safety-net.js';
import {
  TRIGGER_CODES,
  evaluate,
  scenarios,
  type TriggerCode,
} from '../../src/modules/evaluation/handoff-scenarios.js';

const result = await evaluate(
  scenarios,
  (s) =>
    keywordSafetyNet(s.turns).filter((c): c is TriggerCode =>
      (TRIGGER_CODES as readonly string[]).includes(c),
    ),
  SAFETY_NET_COVERS,
);

const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

// Composição do conjunto: os 4 fechados (nota "Decisão docs/05 §8") e os
// adversariais ficam em balde próprio — o resto é o par positivos/negativos.
const isFechado = (s: (typeof scenarios)[number]): boolean => s.note?.startsWith('Decisão docs/05 §8') ?? false;
const adversarial = scenarios.filter((s) => s.id.startsWith('adv-'));
const fechados = scenarios.filter(isFechado);
const rest = scenarios.filter((s) => !s.id.startsWith('adv-') && !isFechado(s));
const positivos = rest.filter((s) => s.expect.triggers.length > 0).length;

console.log('=== Avaliação — rede de segurança por palavras-chave ===');
console.log('');
console.log(
  `cenários: ${scenarios.length} — ${positivos} positivos, ${rest.length - positivos} negativos, ` +
    `${fechados.length} fechados, ${adversarial.length} adversariais`,
);
console.log('');
console.log('gatilho | tp | fp | fn | precisão | recall');
for (const code of SAFETY_NET_COVERS) {
  const m = result.metrics[code];
  console.log(`${code} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)}`);
}
console.log('');
console.log('falhas:');
for (const miss of result.misses) console.log(`- ${miss.id}`);
console.log(`cenários ambíguos (fora da pontuação): ${result.ambiguous.length}`);
