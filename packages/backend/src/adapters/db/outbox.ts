// Enqueue transacional da outbox (Task 17; docs/01 §6, docs/04 §7): a mensagem
// E a linha da outbox nascem numa SÓ transação. Chave repetida ⇒ ROLLBACK (a
// mensagem órfã desaparece) + SELECT da existente, sem 2.º evento. O notify
// `{type:'message', phase:'created'}` sai SÓ depois do commit — o painel nunca
// vê um evento de algo que pode ter sido revertido.

import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { NotifyEvent } from '../../ports/notify.js';
import type { Outbox } from '../../ports/outbox.js';
import type { DbClient } from './index.js';
import { messages, outboxMessages } from './schema/index.js';

/** Sinal interno: a transação fez rollback por chave já existente. */
class DuplicateEnqueue extends Error {
  constructor() {
    super('idempotency_key já existe');
    this.name = 'DuplicateEnqueue';
  }
}

export function createOutbox(deps: {
  db: DbClient;
  notifySink: (e: NotifyEvent) => Promise<void>;
  now(): Date;
  random(): number; // injetável (testes usam 0)
  replyDelay: { min: number; max: number }; // WA_REPLY_DELAY_MS
}): Outbox {
  const { db, notifySink, now, random, replyDelay } = deps;

  // Jitter de resposta: clamp de random() a [0,1] → delay em [min, max]
  // (random()=0 → min exato, coberto pelo teste; nunca abaixo do mínimo).
  const delayMs = (): number => {
    const r = Math.min(Math.max(random(), 0), 1);
    return Math.floor(replyDelay.min + r * (replyDelay.max - replyDelay.min));
  };

  return {
    async enqueue(input) {
      const at = now();
      const messageId = randomUUID();
      const committed = await db
        .transaction(async (tx) => {
          const [m] = await tx
            .insert(messages)
            .values({
              id: messageId,
              conversationId: input.conversationId,
              accountId: input.accountId,
              direction: 'outbound',
              sender: input.sender,
              body: input.text,
              status: 'queued',
              providerMessageId: null, // nulo até o WA-AKG aceitar (docs/04 §5)
              createdAt: at,
              updatedAt: at,
            })
            .returning({ id: messages.id, createdAt: messages.createdAt });
          if (m === undefined) throw new Error('falhou inserir mensagem no enqueue');
          const [row] = await tx
            .insert(outboxMessages)
            .values({
              messageId,
              accountId: input.accountId,
              idempotencyKey: input.idempotencyKey,
              priority: input.sender === 'campaign' ? 2 : 1, // resposta primeiro (docs/04 §7)
              scheduledAt: input.scheduledAt ?? new Date(at.getTime() + delayMs()),
              attempts: 0,
              status: 'queued',
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoNothing({ target: outboxMessages.idempotencyKey })
            .returning({ id: outboxMessages.id });
          if (row === undefined) throw new DuplicateEnqueue(); // ⇒ ROLLBACK da mensagem
          return { outboxId: row.id, createdAt: m.createdAt };
        })
        .catch(async (e: unknown) => {
          if (!(e instanceof DuplicateEnqueue)) throw e;
          // Pós-ROLLBACK: a linha vencedora está commitada e é visível.
          const [existing] = await db
            .select({ id: outboxMessages.id })
            .from(outboxMessages)
            .where(eq(outboxMessages.idempotencyKey, input.idempotencyKey))
            .limit(1);
          if (existing === undefined) throw e; // conflito sem linha visível → erro real
          return { duplicate: true as const, outboxId: existing.id };
        });

      if ('duplicate' in committed) {
        return { outboxId: committed.outboxId, duplicate: true }; // sem 2.º evento
      }

      // COMMIT feito: só agora o evento pode sair (o plano exige esta ordem).
      await notifySink({
        type: 'message',
        phase: 'created',
        messageId,
        conversationId: input.conversationId,
        accountId: input.accountId,
        sender: input.sender,
        status: 'queued',
        createdAt: committed.createdAt,
      });
      return { outboxId: committed.outboxId, duplicate: false };
    },

    async pendingConversationCount(accountId) {
      const [r] = await db
        .select({ n: count() })
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.accountId, accountId),
            inArray(outboxMessages.status, ['queued', 'sending']),
          ),
        );
      return r?.n ?? 0;
    },
  };
}
