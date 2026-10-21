// Job 'inbound.process' (Task 20; docs/05 §3.1): fronteira de payload (zod —
// inválido ⇒ throw, sem processar; o retry é determinístico e morre na
// dead-letter) e despacho pelo tipo do evento normalizado:
//  - message.received → handleInboundEvent (Task 19: claim + orquestrador);
//  - message.status   → avança o estado (docs/04 §8); a conta resolvida marca
//                       `inbound_events.tenant_id` (Task 5, ruling R1);
//  - session.status   → ciclo de vida da conta (docs/04 §6);
//  - session.qr       → QR para o painel.
// Todos os tipos marcam processed_at no fim (message.received é o handler de
// Task 19 que o faz); erro ⇒ rethrow (retry com backoff da Fase 0 — o
// releaseClaim do handle-inbound garante que o retry não é engolido).

import { z } from 'zod';
import {
  findAccountBySession,
  getInboundEventRow,
  markInboundEventProcessed,
  markInboundTenant,
} from '../adapters/db/inbound.js';
import type { DbClient } from '../adapters/db/index.js';
import type { AccountLifecycle } from '../ports/accounts.js';
import type { JobContext } from '../ports/job-queue.js';
import { parseProviderEvent, type ProviderEvent } from '../ports/provider-events.js';
import { reviveTimestamp } from './handle-inbound.js';

const payloadSchema = z
  .object({ eventId: z.string().min(1), correlationId: z.string().min(1) })
  .strict();

export interface InboundProcessDeps {
  db: DbClient;
  now(): Date;
  logger: { warn(obj: object, msg?: string): void };
  /** Task 19: handler completo de `message.received` (já composto no main). */
  runHandleInbound: (eventId: string) => Promise<{ outcome: string }>;
  advanceStatus: (input: {
    /** R31: tenant da conta resolvida — threading para o notify (sem query extra). */
    tenantId: string;
    accountId: string;
    providerMessageId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    at: Date;
  }) => Promise<{ changed: boolean }>;
  lifecycle: AccountLifecycle;
}

export function createInboundProcessHandler(
  deps: InboundProcessDeps,
): (payload: Record<string, unknown>, ctx: JobContext) => Promise<void> {
  return async (payload) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Inválido ⇒ rejeitado sem processar (o ingest nunca gera payloads assim).
      throw new Error('inbound.process: payload inválido (esperado {eventId, correlationId})');
    }
    const { eventId } = parsed.data;

    const row = await getInboundEventRow(deps.db, eventId);
    if (row === null) throw new Error(`inbound.process: evento ${eventId} inexistente`);
    if (row.processedAt !== null) return; // idempotente: reprocessar não repete efeitos

    let event: ProviderEvent;
    try {
      event = parseProviderEvent(reviveTimestamp(row.payload));
    } catch {
      // O evento entrou validado pelo ingest; corrompido ⇒ erro não-transiente.
      throw new Error(`inbound.process: payload do evento ${eventId} inválido`);
    }

    switch (event.type) {
      case 'message.received':
        await deps.runHandleInbound(eventId); // marca processed_at no fim
        return;

      case 'message.status': {
        // Resolução de tenant (ruling R1): a conta da sessão traz o `tenant_id`
        // que passa a pertencer ao evento antes de tocar na mensagem.
        const account = await findAccountBySession(deps.db, event.sessionId);
        if (account === null) {
          deps.logger.warn(
            { reason: 'unknown_session', eventId, sessionId: event.sessionId },
            'inbound.process.account_missing',
          );
          await markInboundEventProcessed(deps.db, eventId, deps.now());
          return;
        }
        await markInboundTenant(deps.db, eventId, account.tenantId);
        await deps.advanceStatus({
          tenantId: account.tenantId, // R31: salas realtime por tenant
          accountId: account.id,
          providerMessageId: event.providerMessageId,
          status: event.status,
          at: event.timestamp,
        });
        await markInboundEventProcessed(deps.db, eventId, deps.now());
        return;
      }

      case 'session.status':
        // O evento normalizado de sessão NÃO tem timestamp (contrato do port,
        // docs/04 §5) — o relógio é o do processamento (docs/04 §6).
        await deps.lifecycle.onSessionStatus({
          sessionId: event.sessionId,
          status: event.status,
          at: deps.now(),
        });
        await markInboundEventProcessed(deps.db, eventId, deps.now());
        return;

      case 'session.qr':
        await deps.lifecycle.onQr({
          sessionId: event.sessionId,
          qr: event.qr,
          at: deps.now(),
        });
        await markInboundEventProcessed(deps.db, eventId, deps.now());
        return;
    }
  };
}
