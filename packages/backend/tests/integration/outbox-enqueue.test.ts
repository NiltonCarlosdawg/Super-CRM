// Fase 1, Task 17: enqueue transacional da outbox (docs/01 §6, docs/04 §7) —
// mensagem + linha numa SÓ transação, idempotência por chave (conflito ⇒
// rollback da mensagem órfã, sem 2.º evento) e evento só DEPOIS do commit.
// Relógio e aleatóriadade injetados (random() = 0 → jitter mínimo).

import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test from 'node:test';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { migratedDb } from '../helpers/db.js';

const AT = new Date('2026-10-07T10:00:00.000Z');

interface Fixtures {
  accountId: string;
  contactId: string;
  conversationId: string;
}

async function fixtures(db: Awaited<ReturnType<typeof migratedDb>>): Promise<Fixtures> {
  const { id: accountId } = await createAccountsRepository({ db }).create({
    label: 'T17',
    purpose: 'support',
    providerSessionId: 'sess-t17',
    now: AT,
  });
  const contact = (
    await db
      .insert(base.contacts)
      .values({ tenantId: base.MILVENDAS_TENANT_ID, phoneE164: '+244923777001', name: 'Cliente T17' })
      .returning({ id: base.contacts.id })
  )[0]!;
  const conversation = (
    await db
      .insert(base.conversations)
      .values({ tenantId: base.MILVENDAS_TENANT_ID, accountId, contactId: contact.id })
      .returning({ id: base.conversations.id })
  )[0]!;
  return { accountId, contactId: contact.id, conversationId: conversation.id };
}

test('enqueue: cria mensagem+outbox numa transação; repetir a chave não duplica nem reemite evento', async () => {
  const db = await migratedDb();
  const notified: NotifyEvent[] = [];
  const o = createOutbox({
    db,
    notifySink: async (e) => {
      notified.push(e);
    },
    now: () => AT,
    random: () => 0,
    replyDelay: { min: 1000, max: 5000 },
  });
  const fx = await fixtures(db);

  const countMessages = async (): Promise<number> => (await db.select().from(base.messages)).length;
  const countNotifications = async (): Promise<number> =>
    notified.filter((n) => n.type === 'message' && n.phase === 'created').length;
  const getOutbox = async (id: string): Promise<{ priority: number; scheduledAt: Date; messageId: string } | undefined> =>
    (
      await db
        .select({
          priority: base.outboxMessages.priority,
          scheduledAt: base.outboxMessages.scheduledAt,
          messageId: base.outboxMessages.messageId,
        })
        .from(base.outboxMessages)
        .where(eq(base.outboxMessages.id, id))
    )[0];

  const input = {
    accountId: fx.accountId,
    contactId: fx.contactId,
    conversationId: fx.conversationId,
    sender: 'human' as const,
    text: 'olá',
    idempotencyKey: 'rest:c1:K1',
  };
  const first = await o.enqueue(input);
  assert.equal(first.duplicate, false);

  const again = await o.enqueue(input);
  assert.equal(again.duplicate, true);
  assert.equal(again.outboxId, first.outboxId);
  assert.equal(await countMessages(), 1, 'rollback da mensagem órfã no conflito');
  assert.equal(await countNotifications(), 1, 'message.created só após o commit da 1.ª');

  const row = await getOutbox(first.outboxId);
  assert.equal(row?.priority, 1);
  assert.equal(
    row?.scheduledAt.toISOString(),
    '2026-10-07T10:00:01.000Z',
    'random()=0 → min do WA_REPLY_DELAY_MS',
  );
  // contrato do evento (Fase 3/4 consomem-no tal como saiu)
  const ev = notified[0]!;
  assert.equal(ev.phase, 'created');
  assert.equal(ev.messageId, row?.messageId);
  assert.equal(ev.conversationId, fx.conversationId);
  assert.equal(ev.accountId, fx.accountId);
  assert.equal(ev.status, 'queued');
  assert.equal(ev.sender, 'human');
  assert.deepEqual(ev.createdAt, AT, 'createdAt do relógio injetado');
  // a linha da mensagem existe e está queued/outbound
  const msg = (await db.select().from(base.messages))[0]!;
  assert.equal(msg.direction, 'outbound');
  assert.equal(msg.status, 'queued');
  assert.equal(msg.providerMessageId, null);
});

test('prioridade: campaign = 2, ai/human = 1; pendingConversationCount só conta queued+sending', async () => {
  const db = await migratedDb();
  const o = createOutbox({
    db,
    notifySink: async () => {},
    now: () => AT,
    random: () => 0,
    replyDelay: { min: 1000, max: 5000 },
  });
  const fx = await fixtures(db);
  const common = {
    accountId: fx.accountId,
    contactId: fx.contactId,
    conversationId: fx.conversationId,
    text: 'promo',
    idempotencyKey: 'campaign:r1',
    scheduledAt: new Date('2026-10-07T11:00:00.000Z'),
  };
  const c = await o.enqueue({ ...common, sender: 'campaign' });
  const byKey = async (key: string): Promise<{ priority: number; scheduledAt: Date } | undefined> =>
    (
      await db
        .select({ priority: base.outboxMessages.priority, scheduledAt: base.outboxMessages.scheduledAt })
        .from(base.outboxMessages)
        .where(eq(base.outboxMessages.idempotencyKey, key))
    )[0];
  const camp = await byKey('campaign:r1');
  assert.equal(camp?.priority, 2);
  assert.equal(camp?.scheduledAt.toISOString(), '2026-10-07T11:00:00.000Z', 'scheduledAt explícito respeitado');

  const a = await o.enqueue({ ...common, sender: 'ai', idempotencyKey: 'ai:r1', text: 'olá' });
  const h = await o.enqueue({ ...common, sender: 'human', idempotencyKey: 'human:r1', text: 'olá' });
  assert.equal((await byKey('ai:r1'))?.priority, 1);
  assert.equal((await byKey('human:r1'))?.priority, 1);
  assert.equal(await o.pendingConversationCount(fx.accountId), 3);

  // marcar uma como 'sent' → pendingConversationCount desce
  await db
    .update(base.outboxMessages)
    .set({ status: 'sent' })
    .where(eq(base.outboxMessages.id, c.outboxId));
  assert.equal(await o.pendingConversationCount(fx.accountId), 2);
  assert.equal(await o.pendingConversationCount('00000000-0000-0000-0000-000000000000'), 0, 'conta sem filas');
  assert.ok(a.duplicate === false && h.duplicate === false);
});
