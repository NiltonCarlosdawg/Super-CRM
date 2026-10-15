// Enqueue transacional da outbox (Task 17; docs/01 §6, docs/04 §7): a mensagem
// E a linha da outbox nascem numa SÓ transação. Chave repetida ⇒ ROLLBACK (a
// mensagem órfã desaparece) + SELECT da existente, sem 2.º evento. O notify
// `{type:'message', phase:'created'}` sai SÓ depois do commit — o painel nunca
// vê um evento de algo que pode ter sido revertido.

import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { types as pgTypes } from 'pg';
import type { AccountStatus } from '../../ports/accounts.js';
import type { NotifyEvent } from '../../ports/notify.js';
import type { Outbox } from '../../ports/outbox.js';
import type { DbClient } from './index.js';
import { contacts, conversations, messages, outboxMessages, whatsappAccounts } from './schema/index.js';

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

// ---------------------------------------------------------------------------
// Operações do worker de envio (Task 18B; docs/04 §7). O SQL fica AQUI: a
// application não importa drizzle-orm (docs/02 §4) e recebe só funções com
// tipagem própria.
// ---------------------------------------------------------------------------

// O `execute` bruto passa pelo parser de identidade do drizzle para TIMESTAMPTZ
// (drizzle-orm/node-postgres/session.js — o drizzle converte nos seus mappers,
// só nos `select`); por isso a coluna chega como texto aqui e ao consumidor.
// Reaplica-se o parser padrão do pg onde se sabe que a coluna é timestamptz.
const parseTimestamptz = pgTypes.getTypeParser(
  pgTypes.builtins.TIMESTAMPTZ,
  'text',
) as (value: string) => Date;

type ClaimedRaw = {
  id: string;
  message_id: string;
  account_id: string;
  idempotency_key: string;
  attempts: number;
  priority: number;
  scheduled_at: string; // texto (ver parseTimestamptz acima)
};

export type ClaimedOutboxRow = {
  id: string;
  messageId: string;
  accountId: string;
  idempotencyKey: string;
  attempts: number;
  priority: number;
  scheduledAt: Date;
};

/** Sweep + claim do tick (docs/04 §7):
 *  1. sweep — `sending` mais velho que o timeout de envio = órfã de crash →
 *     `unknown_delivery` (a mensagem fica `queued`; sem resposta conhecida);
 *  2. claim — `queued` vencidas, ordem (priority ASC, scheduledAt ASC), LIMIT,
 *     `FOR UPDATE SKIP LOCKED`: execuções sobrepostas do tick nunca reivindicam
 *     a mesma linha (docs/02 §6). Linhas devolvidas ordenadas. */
export async function sweepAndClaim(
  db: DbClient,
  input: { now: Date; staleBefore: Date; limit: number },
): Promise<{ stale: number; rows: ClaimedOutboxRow[] }> {
  const sweep = await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'unknown_delivery'::outbox_status, updated_at = ${input.now}
    WHERE status = 'sending' AND updated_at < ${input.staleBefore}
    RETURNING id`);

  const claim = await db.execute<ClaimedRaw>(sql`
    UPDATE outbox_messages AS o
    SET status = 'sending'::outbox_status, updated_at = ${input.now}
    FROM (
      WITH claimed AS (
        SELECT id FROM outbox_messages
        WHERE status = 'queued' AND scheduled_at <= ${input.now}
        ORDER BY priority ASC, scheduled_at ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      SELECT id FROM claimed
    ) AS c
    WHERE o.id = c.id
    RETURNING o.id, o.message_id, o.account_id, o.idempotency_key, o.attempts,
              o.priority, o.scheduled_at`);

  const rows = claim.rows
    .map((r) => ({
      id: r.id,
      messageId: r.message_id,
      accountId: r.account_id,
      idempotencyKey: r.idempotency_key,
      attempts: r.attempts,
      priority: r.priority,
      scheduledAt: parseTimestamptz(r.scheduled_at),
    }))
    .sort(
      (a, b) => a.priority - b.priority || a.scheduledAt.getTime() - b.scheduledAt.getTime(),
    );
  return { stale: sweep.rows.length, rows };
}

export type OutboxStatePatch =
  | { status: 'sent' | 'failed' | 'unknown_delivery' }
  /** Requeue: `scheduledAt` novo; `attempts` só para RESTAURAR (breaker). */
  | { status: 'queued'; scheduledAt: Date; attempts?: number };

/** Transição de estado da linha da outbox. */
export async function setOutboxState(
  db: DbClient,
  outboxId: string,
  patch: OutboxStatePatch,
  at: Date,
): Promise<void> {
  if (patch.status === 'queued') {
    const set =
      patch.attempts !== undefined
        ? {
            status: patch.status,
            updatedAt: at,
            scheduledAt: patch.scheduledAt,
            attempts: patch.attempts,
          }
        : { status: patch.status, updatedAt: at, scheduledAt: patch.scheduledAt };
    await db.update(outboxMessages).set(set).where(eq(outboxMessages.id, outboxId));
    return;
  }
  await db
    .update(outboxMessages)
    .set({ status: patch.status, updatedAt: at })
    .where(eq(outboxMessages.id, outboxId));
}

/** Estado da mensagem espelhado pelo resultado do envio (sent/failed). */
export async function setMessageState(
  db: DbClient,
  messageId: string,
  status: 'sent' | 'failed',
  at: Date,
  providerMessageId?: string,
): Promise<void> {
  await db
    .update(messages)
    .set(
      providerMessageId !== undefined
        ? { status, updatedAt: at, providerMessageId }
        : { status, updatedAt: at },
    )
    .where(eq(messages.id, messageId));
}

/** Claim de envio: `attempts++` SÓ quando se chama o provider (docs/04 §7).
 *  Devolve o valor já incrementado. */
export async function incrementAttempts(
  db: DbClient,
  outboxId: string,
  at: Date,
): Promise<number> {
  const res = await db.execute<{ attempts: number }>(sql`
    UPDATE outbox_messages SET attempts = attempts + 1, updated_at = ${at}
    WHERE id = ${outboxId}
    RETURNING attempts`);
  const row = res.rows[0];
  if (row === undefined) throw new Error(`outbox ${outboxId} inexistente ao incrementar tentativas`);
  return row.attempts;
}

/** Contexto de envio de uma linha reivindicada:
 *  - `account: null` = conta removida → adiar (sem gastar tentativa);
 *  - `msg: null` = dado corrompido (impossível com as FKs) → erro não-transiente. */
export async function loadSendContext(
  db: DbClient,
  input: { accountId: string; messageId: string },
): Promise<{
  account: { status: AccountStatus; providerSessionId: string } | null;
  msg: { conversationId: string; sender: string; body: string | null; to: string } | null;
}> {
  const [account] = await db
    .select({
      status: whatsappAccounts.status,
      providerSessionId: whatsappAccounts.providerSessionId,
    })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, input.accountId))
    .limit(1);
  const [msg] = await db
    .select({
      conversationId: messages.conversationId,
      sender: messages.sender,
      body: messages.body,
      to: contacts.phoneE164,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(messages.id, input.messageId))
    .limit(1);
  return { account: account ?? null, msg: msg ?? null };
}
