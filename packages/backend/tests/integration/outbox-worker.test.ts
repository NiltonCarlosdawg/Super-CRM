// Worker de envio da outbox (Task 18B; docs/04 §7): sweep de linhas 'sending'
// órfãs, claim com SKIP LOCKED, processamento sequencial (serialização),
// adiamento de contas não-connected, backoff transitório, exaustão →
// failed + dead-letter e unknown_delivery NUNCA reenviado (docs/04 §5).
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  CircuitOpenError,
  ProviderUnavailableError,
  type MessagingProvider,
} from '../../src/ports/messaging-provider.js';
import { createOutboxHarness } from '../helpers/outbox.js';

test('timeout → unknown_delivery, mensagem continua queued, SEM reenvio automático', async () => {
  const h = await createOutboxHarness();
  h.fake.queueResult({ providerMessageId: null, outcome: 'unknown' });
  await h.enqueueFixture({ sender: 'human', text: 'olá', idempotencyKey: 'unknown:1' });
  await h.runOutboxWorker();
  await h.runOutboxWorker();
  await h.runOutboxWorker();
  assert.equal(h.fake.sendTextCalls.length, 1, 'nunca reenvia um envio de resultado desconhecido');
  assert.equal((await h.getOutboxRow()).status, 'unknown_delivery');
  assert.equal((await h.getMessageRow()).status, 'queued');
  assert.ok(
    h.logs().some((l) => l.level === 'error' && l.reason === 'send_unknown'),
    'log de reconciliação send_unknown',
  );
});

test('serialização e prioridade: nunca 2 envios simultâneos; resposta antes de campanha', async () => {
  const h = await createOutboxHarness();
  let inFlight = 0;
  let maxInFlight = 0;
  const keys: string[] = [];
  const provider: MessagingProvider = {
    sendText: async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      keys.push(input.idempotencyKey);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      // Único por chamada: o índice (account_id, provider_message_id) é UNIQUE.
      return { providerMessageId: `m-${keys.length}`, outcome: 'accepted' };
    },
    sendMedia: async () => ({ providerMessageId: 'm-media', outcome: 'accepted' }),
    verifyAndParseWebhook: () => [],
  };
  // Campanha mais antiga (prio 2) e resposta recente (prio 1): a resposta sai PRIMEIRO.
  await h.enqueueFixture({
    sender: 'campaign',
    idempotencyKey: 'campaign:1',
    scheduledAt: new Date(h.now().getTime() - 10_000),
  });
  await h.enqueueFixture({
    sender: 'ai',
    idempotencyKey: 'inbound:1',
    scheduledAt: new Date(h.now().getTime() - 1_000),
  });
  const { claimed, sent } = await h.runOutboxWorker({ provider });
  assert.equal(maxInFlight, 1, 'processamento sequencial: nunca 2 envios simultâneos');
  assert.deepEqual(keys, ['inbound:1', 'campaign:1'], 'prioridade ASC, depois scheduledAt ASC');
  assert.equal(claimed, 2);
  assert.equal(sent, 2);
});

test('conta não-connected adia SEM gastar tentativa; suspected_ban adia igual', async () => {
  const h = await createOutboxHarness();
  await h.enqueueFixture({ sender: 'human', text: 'olá', idempotencyKey: 'defer:1' });
  await h.accounts.setStatus({ tenantId: h.acc.tenantId }, h.acc.id, 'disconnected', h.now());
  await h.runOutboxWorker();
  let row = await h.getOutboxRow();
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);
  assert.equal(h.fake.sendTextCalls.length, 0, 'não chama o provider sem conta connected');
  assert.ok(
    row.scheduledAt.getTime() >= h.now().getTime() + 30_000 - 50,
    'requeue com WA_OUTBOX_RETRY_DELAY_MS',
  );
  // suspected_ban adia exatamente igual
  await h.accounts.setStatus({ tenantId: h.acc.tenantId }, h.acc.id, 'suspected_ban', h.now());
  h.advance(40_000); // a fila volta a ficar devida
  await h.runOutboxWorker();
  row = await h.getOutboxRow();
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);
  assert.equal(h.fake.sendTextCalls.length, 0);
  assert.ok(row.scheduledAt.getTime() >= h.now().getTime() + 30_000 - 50);
});

test('transientes esgotam em WA_SEND_MAX_ATTEMPTS → failed + dead-letter; aceitação → sent + message.status', async () => {
  const h = await createOutboxHarness();
  await h.enqueueFixture({ sender: 'ai', text: 'ola', idempotencyKey: 'exhaust:1' });
  for (let i = 0; i < 5; i += 1) {
    h.fake.queueResult(new ProviderUnavailableError('fetch failed'));
    h.advance(3_600_000); // o backoff nunca atrasa o próximo tick em teste
    await h.runOutboxWorker();
  }
  assert.equal(h.fake.sendTextCalls.length, 5, 'uma chamada ao provider por tentativa');
  assert.equal((await h.getOutboxRow()).status, 'failed');
  assert.equal((await h.getMessageRow()).status, 'failed');
  assert.ok(h.logs().some((l) => l.deadLetter === true), 'dead-letter registado em log');

  // aceitação: outbox sent, mensagem sent + provider_message_id, notify message.status
  await h.enqueueFixture({ sender: 'ai', text: 'ola', idempotencyKey: 'accept:1' });
  h.fake.queueResult({ providerMessageId: 'pm-accepted', outcome: 'accepted' });
  h.advance(3_600_000);
  await h.runOutboxWorker();
  assert.equal((await h.getOutboxRow('accept:1')).status, 'sent');
  const msg = await h.getMessageRow('accept:1');
  assert.equal(msg.status, 'sent');
  assert.equal(msg.providerMessageId, 'pm-accepted');
  assert.ok(
    h.notified.some((e) => e.type === 'message' && e.phase === 'status' && e.status === 'sent'),
    'evento message.status notificado ao painel',
  );
});

test("sweep: linha 'sending' velha (crash) → unknown_delivery", async () => {
  const h = await createOutboxHarness();
  const { outboxId } = await h.enqueueFixture({ sender: 'ai', text: 'ola', idempotencyKey: 'stale:1' });
  // Simula crash: a linha ficou 'sending' com updated_at antes de now - (sendTimeoutMs + 10s).
  const staleAt = new Date(h.now().getTime() - (15_000 + 10_000 + 5_000));
  await h.db
    .update(base.outboxMessages)
    .set({ status: 'sending', updatedAt: staleAt })
    .where(eq(base.outboxMessages.id, outboxId));
  const r = await h.runOutboxWorker();
  assert.equal(r.claimed, 0, 'a linha varrida NÃO volta a entrar no claim');
  assert.equal(h.fake.sendTextCalls.length, 0, 'sweep não reenvia');
  assert.equal((await h.getOutboxRow()).status, 'unknown_delivery');
  assert.equal((await h.getMessageRow()).status, 'queued', 'sem resposta conhecida do provider');
  assert.ok(
    h.logs().some((l) => l.level === 'warn' && l.reason === 'stale_sending'),
    'log alerta stale_sending',
  );
});

test('CircuitOpenError adia sem gastar tentativa (restaura attempts)', async () => {
  const h = await createOutboxHarness();
  await h.enqueueFixture({ sender: 'ai', text: 'ola', idempotencyKey: 'circuit:1' });
  h.fake.queueResult(new CircuitOpenError('breaker aberto'));
  await h.runOutboxWorker();
  const row = await h.getOutboxRow();
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0, 'breaker não consome tentativas');
  assert.equal(h.fake.sendTextCalls.length, 1);
  assert.ok(row.scheduledAt.getTime() >= h.now().getTime() + 30_000 - 50);
});
