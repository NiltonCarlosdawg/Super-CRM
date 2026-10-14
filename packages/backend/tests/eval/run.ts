// Runner da avaliação — rede de segurança por palavras-chave. Correr com: npm run eval
// Classifica os 72 cenários sintéticos de handoff-scenarios.ts com a função pura
// keywordSafetyNet (só os gatilhos cobertos) e imprime o relatório de docs/05 §8.

import { SAFETY_NET_COVERS, keywordSafetyNet } from '../../src/domain/keyword-safety-net.js';
import { TRIGGER_CODES, evaluate, scenarios, type TriggerCode } from './handoff-scenarios.js';

const result = await evaluate(
  scenarios,
  (s) =>
    keywordSafetyNet(s.turns).filter((c): c is TriggerCode =>
      (TRIGGER_CODES as readonly string[]).includes(c),
    ),
  SAFETY_NET_COVERS,
);

const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

console.log('=== Avaliação — rede de segurança por palavras-chave ===');
console.log('');
console.log('gatilho | tp | fp | fn | precisão | recall');
for (const code of SAFETY_NET_COVERS) {
  const m = result.metrics[code];
  console.log(`${code} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)}`);
}
console.log('');
console.log('falhas:');
for (const miss of result.misses) console.log(`- ${miss.id}`);
console.log(`cenários ambíguos (fora da pontuação): ${result.ambiguous.join(', ')}`);
