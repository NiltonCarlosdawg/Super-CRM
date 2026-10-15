// Handler de eventos recebidos (Task 19; docs/05 §3.1): fronteira do job de
// inbound (Task 20). Um passo por efeito colateral:
//  1. evento processado → no-op (reentrega de webhook/job); claim fresco de
//     outro worker → erro reprocessável;
//  2. revalidação na fronteira do job (o payload de jsonb perde tipos); tipo ≠
//     message.received → skipped; `from` não-normalizável → processed + skipped
//     (evento venenoso não entra em retry infinito, docs/02 §3);
//  3. conta pela sessão do WA-AKG; desconhecida → processed + skipped;
//  4. guarda idempotente: contacto (upsert) → conversa (UNIQUE conta+contacto)
//     → lead em falta → mensagem (UNIQUE conta+provider_message_id) + notify;
//  5. seam de efeitos (opt-out/markReplied, Fase 4) — erro propaga, nunca
//     `catch {}`;
//  6. orquestrador (`msg.id` é o id do evento: o claim é em inbound_events);
//  7. duplicate ⇒ outro worker venceu a corrida → erro reprocessável;
//  8. resposta: mode 'send' → enfileira (sender 'ai'); 'draft' → só rascunho
//     (aprovacao humana é Fase 3) com log estruturado sem texto;
//  9. processed_at; 10. erro ⇒ releaseClaim best-effort + rethrow.

import {
  ensureLeadForConversation,
  findAccountBySession,
  findOrCreateContact,
  findOrCreateConversation,
  getInboundEventRow,
  markInboundEventProcessed,
  storeInboundMessage,
} from '../adapters/db/inbound.js';
import type { DbClient } from '../adapters/db/index.js';
import { normalizePhoneE164 } from '../domain/phone.js';
import type { Ports } from '../ports/ai-provider.js';
import type { NotifyEvent } from '../ports/notify.js';
import type { Outbox } from '../ports/outbox.js';
import { parseProviderEvent, type ProviderEvent } from '../ports/provider-events.js';
import type { InboundMessage, Outcome } from './orchestrator.js';

/** Claim em disputa/perdido: a fila tenta mais tarde (o vencedor marca processed). */
export class RetryableConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableConflictError';
  }
}

export interface HandleInboundDeps {
  db: DbClient;
  ports: Ports & { releaseClaim(eventId: string): Promise<void> };
  /** Fase 1: (m) => handleInbound(ports, aiProvider, m). Seam de testes. */
  orchestrate: (msg: InboundMessage) => Promise<Outcome>;
  outbox: Outbox;
  notifySink: (e: NotifyEvent) => Promise<void>;
  cfg: { claimTtlMs: number };
  now(): Date;
  logger: {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  /** Seam Fase 4 (opt-out/markReplied): depois da mensagem guardada, antes do
   *  orquestrador. Default no-op. Erro propaga — nunca `catch {}`. */
  inboundEffects?: (input: {
    contactId: string;
    conversationId: string;
    text: string;
    receivedAt: Date;
  }) => Promise<void>;
}

/** jsonb perde os tipos: `timestamp` volta como string ISO — reidratar antes
 *  de revalidar na fronteira do job (docs/02 §3). Reutilizado pelo job
 *  'inbound.process' (Task 20). */
export const reviveTimestamp = (payload: unknown): unknown => {
  const p = payload as { timestamp?: unknown } | null;
  return p !== null && typeof p.timestamp === 'string'
    ? { ...p, timestamp: new Date(p.timestamp) }
    : payload;
};

export async function handleInboundEvent(
  deps: HandleInboundDeps,
  eventId: string,
): Promise<{ outcome: 'skipped' | 'processed' | Outcome['status'] }> {
  const at = deps.now();

  // 1. Reentrega → no-op; claim fresco de outro worker → reprocessável.
  const row = await getInboundEventRow(deps.db, eventId);
  if (row === null) throw new Error(`evento ${eventId} inexistente`);
  if (row.processedAt !== null) return { outcome: 'skipped' };
  if (
    row.aiClaimedAt !== null &&
    at.getTime() - row.aiClaimedAt.getTime() < deps.cfg.claimTtlMs
  ) {
    throw new RetryableConflictError(`claimed_elsewhere: evento ${eventId} tem claim fresco`);
  }

  try {
    // 2. Revalidação na fronteira do job.
    let event: ProviderEvent;
    try {
      event = parseProviderEvent(reviveTimestamp(row.payload));
    } catch {
      await markInboundEventProcessed(deps.db, eventId, at);
      deps.logger.error({ reason: 'payload_invalid', eventId }, 'inbound.payload_invalid');
      return { outcome: 'skipped' };
    }
    if (event.type !== 'message.received') {
      return { outcome: 'skipped' }; // outros tipos são despachados noutro handler
    }
    const phone = normalizePhoneE164(event.from);
    if (phone === null) {
      await markInboundEventProcessed(deps.db, eventId, at);
      deps.logger.error({ reason: 'payload_invalid', eventId }, 'inbound.from_invalid');
      return { outcome: 'skipped' };
    }

    // 3. Conta que serve a sessão do WA-AKG.
    const account = await findAccountBySession(deps.db, event.sessionId);
    if (account === null) {
      await markInboundEventProcessed(deps.db, eventId, at);
      deps.logger.warn(
        { reason: 'unknown_session', eventId, sessionId: event.sessionId },
        'inbound.account_missing',
      );
      return { outcome: 'skipped' };
    }

    // 4. Guardar (idempotente) + notify.message.created.
    const text = event.message.text ?? null;
    const contact = await findOrCreateContact(deps.db, { phoneE164: phone, at });
    const conversation = await findOrCreateConversation(deps.db, {
      accountId: account.id,
      contactId: contact.id,
      at,
    });
    await ensureLeadForConversation(deps.db, {
      contactId: contact.id,
      conversationId: conversation.id,
      at,
    });
    const stored = await storeInboundMessage(deps.db, {
      accountId: account.id,
      conversationId: conversation.id,
      providerMessageId: event.providerMessageId,
      kind: event.message.kind,
      body: text,
      mediaRef: event.message.mediaRef ?? null,
      at: event.timestamp,
    });
    await deps.notifySink({
      type: 'message',
      phase: 'created',
      messageId: stored.id,
      conversationId: conversation.id,
      accountId: account.id,
      sender: 'customer',
      status: 'delivered',
      createdAt: stored.createdAt,
    });

    // 5. Seam de efeitos (Fase 4): sempre com o texto real; erro propaga.
    await deps.inboundEffects?.({
      contactId: contact.id,
      conversationId: conversation.id,
      text: text ?? '',
      receivedAt: event.timestamp,
    });

    // 6. Orquestrador: `msg.id` é o id do evento (o claim é em inbound_events).
    const outcome = await deps.orchestrate({
      id: eventId,
      conversationId: conversation.id,
      text: text ?? '',
      isTest: false,
    });

    // 7. duplicate ⇒ outro worker tem o claim (corrida) → reprocessável.
    if (outcome.status === 'duplicate') {
      throw new RetryableConflictError(`retryable: evento ${eventId} claimado por outro worker`);
    }

    // 8. Resposta: send enfileira; draft fica registado em answer_traces (o
    //    rascunho vive lá — a aprovação é Fase 3); log sem o texto.
    if (outcome.mode === 'send' && outcome.reply !== null) {
      await deps.outbox.enqueue({
        accountId: account.id,
        contactId: contact.id,
        conversationId: conversation.id,
        sender: 'ai',
        text: outcome.reply,
        idempotencyKey: `inbound:${eventId}`,
      });
    } else if (outcome.mode === 'draft' && outcome.reply !== null) {
      deps.logger.info(
        { reason: 'reply_draft_pending', correlationId: eventId },
        'inbound.reply_draft',
      );
    }

    // 9. Fim: processed_at é a guarda terminal de reentrega.
    await markInboundEventProcessed(deps.db, eventId, at);
    return { outcome: 'processed' };
  } catch (error) {
    // 10. Best effort: libertar o NOSSO claim para o retry não esperar o TTL.
    // Claim de outro worker (RetryableConflictError) NUNCA é libertado aqui.
    if (!(error instanceof RetryableConflictError)) {
      await deps.ports.releaseClaim(eventId).catch(() => undefined);
    }
    throw error;
  }
}
