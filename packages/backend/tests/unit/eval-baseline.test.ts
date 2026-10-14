// Baseline do evaluate() contra docs/05 §8. Correr com: npm test
// Classificador = rede de segurança por palavras-chave sobre os 72 cenários sintéticos.
// Fixa os números da spec: precisão 100/100, recall 100% em compra e 75% em pedido de humano.

import assert from 'node:assert/strict';
import test from 'node:test';
import { SAFETY_NET_COVERS, keywordSafetyNet } from '../../src/domain/keyword-safety-net.js';
import {
  TRIGGER_CODES,
  evaluate,
  scenarios,
  type TriggerCode,
} from '../eval/handoff-scenarios.js';

test('baseline da rede de segurança: 72 cenários, 4 ambíguos, precisão/recall de docs/05 §8', async () => {
  const result = await evaluate(
    scenarios,
    (s) =>
      keywordSafetyNet(s.turns).filter((c): c is TriggerCode =>
        (TRIGGER_CODES as readonly string[]).includes(c),
      ),
    SAFETY_NET_COVERS,
  );

  assert.equal(scenarios.length, 72);
  assert.equal(result.ambiguous.length, 4);
  assert.equal(result.metrics.purchase_intent.precision, 1);
  assert.equal(result.metrics.purchase_intent.recall, 1);
  assert.equal(result.metrics.human_requested.precision, 1);
  assert.equal(result.metrics.human_requested.recall, 0.75);
  // docs/05 §8: recall 75% em human_requested — a única FN é hr-04, cenário
  // deliberadamente sem palavras-chave (testa o classificador, não a regra).
  // O harness lista em misses qualquer fp/fn (handoff-scenarios.ts:654).
  assert.deepEqual(
    result.misses.map((m) => m.id),
    ['hr-04'],
  );
  assert.deepEqual(result.misses[0]?.expected, ['human_requested']);
  assert.deepEqual(result.misses[0]?.predicted, []);
});
