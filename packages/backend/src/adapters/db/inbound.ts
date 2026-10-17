// Persistência dos eventos recebidos (Task 19; docs/05 §3.1): o SQL do handler
// de inbound vive AQUI — a application não importa drizzle-orm (docs/02 §1;
// mesmo padrão das operações do worker na Task 18B).

import { and, eq } from 'drizzle-orm';
import type { DbClient } from './index.js';
import {
  contacts,
  conversations,
  inboundEvents,
  leads,
  messages,
  whatsappAccounts,
} from './schema/index.js';

export type InboundEventRow = {
  payload: unknown;
  processedAt: Date | null;
  aiClaimedAt: Date | null;
};

export async function getInboundEventRow(
  db: DbClient,
  eventId: string,
): Promise<InboundEventRow | null> {
  const [row] = await db
    .select({
      payload: inboundEvents.payload,
      processedAt: inboundEvents.processedAt,
      aiClaimedAt: inboundEvents.aiClaimedAt,
    })
    .from(inboundEvents)
    .where(eq(inboundEvents.id, eventId))
    .limit(1);
  return row ?? null;
}

/** Guarda terminal de reentrega (docs/02 §3): processado nunca mais repete efeitos. */
export async function markInboundEventProcessed(
  db: DbClient,
  eventId: string,
  at: Date,
): Promise<void> {
  await db.update(inboundEvents).set({ processedAt: at }).where(eq(inboundEvents.id, eventId));
}

/** Conta do WA-AKG que serve esta sessão; desconhecida ⇒ evento sem dono.
 *  Onda 1 (Task 5, ruling R1): SEM tenant scope — esta função É a resolução de
 *  tenant do webhook/job; o `tenantId` devolvido é propagado a todo o resto. */
export async function findAccountBySession(
  db: DbClient,
  sessionId: string,
): Promise<{ id: string; tenantId: string } | null> {
  const [row] = await db
    .select({ id: whatsappAccounts.id, tenantId: whatsappAccounts.tenantId })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.providerSessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** Onda 1 (Task 5): o evento passa a pertencer ao tenant da conta resolvida
 *  (spec §4.2 — `inbound_events.tenant_id` anulável preenchido no job). */
export async function markInboundTenant(
  db: DbClient,
  eventId: string,
  tenantId: string,
): Promise<void> {
  await db.update(inboundEvents).set({ tenantId }).where(eq(inboundEvents.id, eventId));
}

/** Upsert por E.164 — NÃO toca em consentimento/opt-out (docs/04 §7). */
export async function findOrCreateContact(
  db: DbClient,
  input: { tenantId: string; phoneE164: string; at: Date },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: input.tenantId, // Onda 1 (Task 5): tenant da conta resolvida
      phoneE164: input.phoneE164,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      // Fixo R17 (Task 5): o target é o composto (tenant_id, phone_e164) — o
      // upsert é escopado: B recebe a SUA linha, nunca a de A.
      target: [contacts.tenantId, contacts.phoneE164],
      set: { updatedAt: input.at },
    })
    .returning({ id: contacts.id });
  if (row === undefined) throw new Error('falhou criar/encontrar contacto');
  return row;
}

/** Uma conversa por (conta, contacto) — o upsert NUNCA toca em ai_mode/lead_id
 *  (um humano pode já ter mudado o modo; docs/04 §6). */
export async function findOrCreateConversation(
  db: DbClient,
  input: { tenantId: string; accountId: string; contactId: string; at: Date },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(conversations)
    .values({
      tenantId: input.tenantId, // Onda 1 (Task 5): tenant da conta resolvida
      accountId: input.accountId,
      contactId: input.contactId,
      lastMessageAt: input.at,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [conversations.accountId, conversations.contactId],
      set: { lastMessageAt: input.at, updatedAt: input.at },
    })
    .returning({ id: conversations.id });
  if (row === undefined) throw new Error('falhou criar/encontrar conversa');
  return row;
}

/** Lead em falta na conversa → INSERT (stage 'open', qualification '{}') + link. */
export async function ensureLeadForConversation(
  db: DbClient,
  input: { tenantId: string; contactId: string; conversationId: string; at: Date },
): Promise<void> {
  const [conv] = await db
    .select({ leadId: conversations.leadId })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.tenantId, input.tenantId)))
    .limit(1);
  if (conv === undefined) throw new Error(`conversa ${input.conversationId} inexistente`);
  if (conv.leadId !== null) return; // já ligado (retry ou conversa pré-existente)
  const [lead] = await db
    .insert(leads)
    .values({
      tenantId: input.tenantId, // Onda 1 (Task 5): tenant da conta resolvida
      contactId: input.contactId,
      lineId: null,
      stage: 'open',
      qualification: {},
      createdAt: input.at,
      updatedAt: input.at,
    })
    .returning({ id: leads.id });
  if (lead === undefined) throw new Error('falhou criar lead');
  await db
    .update(conversations)
    .set({ leadId: lead.id, updatedAt: input.at })
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.tenantId, input.tenantId)));
}

/** Mensagem idempotente: UNIQUE (conta, provider_message_id) DO NOTHING + SELECT. */
export async function storeInboundMessage(
  db: DbClient,
  input: {
    tenantId: string;
    accountId: string;
    conversationId: string;
    providerMessageId: string;
    kind: NonNullable<typeof messages.$inferInsert['kind']>;
    body: string | null;
    mediaRef: string | null;
    at: Date;
  },
): Promise<{ id: string; createdAt: Date }> {
  const inserted = await db
    .insert(messages)
    .values({
      tenantId: input.tenantId, // Onda 1 (Task 5): tenant da conta resolvida
      conversationId: input.conversationId,
      accountId: input.accountId,
      direction: 'inbound',
      sender: 'customer',
      kind: input.kind,
      body: input.body,
      mediaRef: input.mediaRef,
      providerMessageId: input.providerMessageId,
      status: 'delivered', // recebida por nós (docs/04 §5)
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoNothing({ target: [messages.accountId, messages.providerMessageId] })
    .returning({ id: messages.id, createdAt: messages.createdAt });
  if (inserted[0] !== undefined) return inserted[0];
  const [existing] = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, input.tenantId),
        eq(messages.accountId, input.accountId),
        eq(messages.providerMessageId, input.providerMessageId),
      ),
    )
    .limit(1);
  if (existing === undefined) throw new Error('conflito de mensagem sem linha visível');
  return existing;
}

/** Insere o evento normalizado; chave repetida ⇒ null (duplicado do webhook). */
export async function insertInboundEvent(
  db: DbClient,
  input: { providerEventId: string; payload: unknown },
): Promise<{ id: string } | null> {
  const [row] = await db
    .insert(inboundEvents)
    .values({ providerEventId: input.providerEventId, payload: input.payload })
    .onConflictDoNothing({ target: inboundEvents.providerEventId })
    .returning({ id: inboundEvents.id });
  return row ?? null;
}

type MessageRow = typeof messages.$inferSelect;

/** Avanço condicional do estado de UMA mensagem (docs/04 §8): linha travada
 *  com FOR UPDATE na transação, o `computeNext` (matriz pura, Task 20) decide
 *  e só escreve se o estado mudar — dois eventos concorrentes nunca regredem. */
export async function advanceMessageStatusRow(
  db: DbClient,
  input: {
    accountId: string;
    providerMessageId: string;
    at: Date;
    computeNext: (current: MessageRow['status']) => MessageRow['status'];
  },
): Promise<
  | { changed: false }
  | {
      changed: true;
      row: {
        messageId: string;
        conversationId: string;
        sender: MessageRow['sender'];
        status: MessageRow['status'];
      };
    }
> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        sender: messages.sender,
        status: messages.status,
      })
      .from(messages)
      .where(
        and(eq(messages.accountId, input.accountId), eq(messages.providerMessageId, input.providerMessageId)),
      )
      .for('update')
      .limit(1);
    if (row === undefined) return { changed: false as const }; // mensagem desconhecida → no-op
    const next = input.computeNext(row.status);
    if (next === row.status) return { changed: false as const };
    await tx
      .update(messages)
      .set({ status: next, updatedAt: input.at })
      .where(eq(messages.id, row.id));
    return {
      changed: true as const,
      row: {
        messageId: row.id,
        conversationId: row.conversationId,
        sender: row.sender,
        status: next,
      },
    };
  });
}
