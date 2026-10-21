// Fase 3, Task 15: varredura de abertura e SLA de 15 min (ADR-0003 A6.1).
// Corre como job recorrente (60 s) e olha para os handoffs `pending` de TODOS
// os tenants — manutenção de sistema, como o tick da outbox (o batch devolve o
// `tenantId` por linha e as operações seguintes correm sob scope).
//
// Regras, por pendente (ordem A antes de B):
//  (A) abertura — `openingAlertedAt === null` e a criação foi fora de horas e
//      agora está aberto → alerta, conversa a `human_only`, marcação CAS e audit.
//  (B) SLA de aceitação — o relógio conta da ABERTURA (se criado fora de horas)
//      ou da CRIAÇÃO (se em horário) até `now`, só com a porta aberta; ao
//      atingir `sla.acceptAlertMinutes` → alerta, marcação CAS e audit.
// O CAS de `mark*` garante exatamente-UM alerta mesmo com dois ticks
// sobrepostos (docs/02 §6: todo o job é idempotente).

import { businessMinutesBetween, isOpenAt } from '../domain/business-hours.js';
import type { Settings } from '../modules/settings/settings.js';
import type { AiMode, Ports } from '../ports/ai-provider.js';
import type { Audit } from '../ports/audit.js';
import type { HandoffQueueRepository } from '../ports/handoff-queue.js';
import type { TenantScope } from '../ports/tenancy.js';

/** Teto de pendentes varridos por passagem (evita varrer filas intermináveis). */
const SWEEP_LIMIT = 500;

export interface SweepDeps {
  queue: HandoffQueueRepository;
  /** Scope por linha: o tenant vem do `SweepHandoff`, nunca de um hardcode. */
  conversations: {
    setAiMode(scope: TenantScope, conversationId: string, mode: AiMode): Promise<void>;
  };
  settings: Settings;
  audit: Audit;
  notify: Ports['notify'];
}

export async function runHandoffScheduleSweep(
  d: SweepDeps,
  now: Date,
): Promise<{ openingAlerts: number; slaAlerts: number }> {
  const b = d.settings.businessHours;
  const nowOpen = isOpenAt(now, b);
  const rows = await d.queue.listPendingForSweep(SWEEP_LIMIT);
  const counts = { openingAlerts: 0, slaAlerts: 0 };

  for (const row of rows) {
    const scope: TenantScope = { tenantId: row.tenantId };

    // (A) abertura: criado fora de horas e agora aberto.
    if (row.openingAlertedAt === null && !isOpenAt(row.createdAt, b) && nowOpen) {
      const claimed = await d.queue.markOpeningAlerted(scope, row.id, now);
      if (claimed) {
        await d.conversations.setAiMode(scope, row.conversationId, 'human_only');
        await d.notify({
          type: 'alert',
          handoffId: row.id,
          conversationId: row.conversationId,
          priority: row.priority,
          reason: 'opening_pending',
          outsideHours: false,
        });
        await d.audit.record({
          tenantId: row.tenantId,
          actorId: null, // ação de sistema (job)
          action: 'handoff.opening_alert',
          entity: 'handoff',
          entityId: row.id,
          at: now,
        });
        counts.openingAlerts += 1;
      }
    }

    // (B) SLA: referência = abertura (se criado fora de horas) ou criação (em
    // horário). `null` = ainda não está na fila do time (fora de horas, abertura
    // pendente) → não conta SLA esta passagem.
    const slaRef =
      row.openingAlertedAt !== null
        ? row.openingAlertedAt
        : isOpenAt(row.createdAt, b)
          ? row.createdAt
          : null;
    if (
      slaRef !== null &&
      row.slaAlertedAt === null &&
      nowOpen &&
      businessMinutesBetween(slaRef, now, b) >= d.settings.sla.acceptAlertMinutes
    ) {
      const claimed = await d.queue.markSlaAlerted(scope, row.id, now);
      if (claimed) {
        await d.notify({
          type: 'alert',
          handoffId: row.id,
          conversationId: row.conversationId,
          priority: row.priority,
          reason: 'sla_accept_15min',
          outsideHours: false,
        });
        await d.audit.record({
          tenantId: row.tenantId,
          actorId: null, // ação de sistema (job)
          action: 'handoff.sla_alert',
          entity: 'handoff',
          entityId: row.id,
          at: now,
        });
        counts.slaAlerts += 1;
      }
    }
  }

  return counts;
}
