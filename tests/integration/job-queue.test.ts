import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobQueue } from '../../src/adapters/queue/index.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout à espera de condição');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('enqueue idempotente: mesma idempotencyKey executa o handler uma só vez', async () => {
  const queue = createJobQueue({ redisUrl: TEST_REDIS_URL });
  const correlations: string[] = [];
  let runs = 0;
  await queue.register('test.noop', async (_payload, ctx) => {
    runs += 1;
    correlations.push(ctx.correlationId);
  });
  const payload = { leadId: '00000000-0000-4000-8000-000000000001' };
  await queue.enqueue('test.noop', payload, { idempotencyKey: 'k-1', correlationId: 'corr-1' });
  await queue.enqueue('test.noop', payload, { idempotencyKey: 'k-1', correlationId: 'corr-2' });
  await waitFor(() => runs >= 1);
  await new Promise((r) => setTimeout(r, 300)); // janela para um 2.º execução indesejada
  assert.equal(runs, 1);
  assert.deepEqual(correlations, ['corr-1']);
  await queue.close();
});
