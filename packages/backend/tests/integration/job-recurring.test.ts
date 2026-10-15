// Fase 1, Task 18: jobs recorrentes no port JobQueue (docs/02 §6) — contrato:
// o handler dispara a cada everyMs e registar duas vezes o mesmo nome é no-op
// (não duplica execuções). Payload vazio por design (nada de dados em jobs).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobQueue } from '../../src/adapters/queue/index.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

test('registerRecurring: dispara a cada everyMs; registrar duas vezes não duplica execuções', async () => {
  const queue = createJobQueue({ redisUrl: TEST_REDIS_URL });
  let runs = 0;
  const h = async (): Promise<void> => {
    runs += 1;
  };
  await queue.registerRecurring('test.repeat', h, { everyMs: 100 });
  await queue.registerRecurring('test.repeat', h, { everyMs: 100 }); // 2.ª chamada = no-op
  await new Promise((r) => setTimeout(r, 550));
  await queue.close();
  assert.ok(runs >= 3 && runs <= 6, `runs=${runs} (3–6 em 550ms; >6 houve duplicação)`);
});
