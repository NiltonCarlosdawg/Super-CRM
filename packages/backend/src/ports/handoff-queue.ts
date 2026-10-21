// Port da fila de handoffs (Fase 3, Task 14): claim, resolução e listagem para
// o painel humano (ADR-0003 A6.1, A10). O `claim` é O comutador: o primeiro
// humano a aceitar fica com o handoff (UPDATE … WHERE status='pending', atómico).
//
// Onda 1: toda a operação leva `TenantScope` — cross-tenant esconde a
// existência (nunca 403), como o resto do negócio (spec multitenant §4.3).

import type { Priority } from './ai-provider.js';
import type { TenantScope } from './tenancy.js';

export interface HandoffRow {
  id: string;
  conversationId: string;
  status: 'pending' | 'accepted' | 'resolved' | 'dismissed';
  priority: Priority;
  createdAt: Date;
  openingAlertedAt: Date | null;
  slaAlertedAt: Date | null;
  /** Resumo gerado pela IA — visível ao humano que aceita. */
  summary: string;
  /** Motivo do handoff (o gatilho que o disparou). */
  reason: string;
  leadSnapshot: unknown;
}

/**
 * Linha da varredura: um pendente + o seu tenant. O sweep (Fase 3, Task 15) é um
 * job GLOBAL de sistema — consulta pendentes de todos os tenants e devolve o
 * `tenantId` em cada linha, para as operações seguintes correrem sob scope
 * (mesmo padrão de `claimOutboxBatch`: batch global que carrega o tenant).
 */
export type SweepHandoff = HandoffRow & { tenantId: string };

export interface HandoffQueueRepository {
  /** Claim atómico: 'claimed' se venceu; 'taken' se já aceite; 'not_found' se não existe/alheio. */
  claim(
    scope: TenantScope,
    handoffId: string,
    userId: string,
    now: Date,
  ): Promise<'claimed' | 'taken' | 'not_found'>;
  get(scope: TenantScope, handoffId: string): Promise<HandoffRow | null>;
  resolve(
    scope: TenantScope,
    handoffId: string,
    userId: string,
    now: Date,
  ): Promise<'resolved' | 'not_found'>;
  /** Fila pendente, da mais urgente para a mais antiga dentro de cada prioridade. */
  listPending(scope: TenantScope, limit: number): Promise<HandoffRow[]>;
  /**
   * Varredura de sistema (job global): pendentes de TODOS os tenants, cada linha
   * com o seu `tenantId` — sem escopo, porque o sweep é manutenção transversal
   * (padrão outbox). As operações seguintes (mark, setAiMode) são por-linha scoped.
   */
  listPendingForSweep(limit: number): Promise<SweepHandoff[]>;
  /**
   * Marca o alerta de abertura com CAS idempotente (`WHERE opening_alerted_at IS
   * NULL RETURNING id`): devolve `true` SÓ a quem venceu a corrida — garante
   * exatamente-um alerta mesmo com dois ticks do job sobrepostos (docs/02 §6).
   */
  markOpeningAlerted(scope: TenantScope, handoffId: string, now: Date): Promise<boolean>;
  /** Marca o alerta de SLA com CAS idempotente (ver `markOpeningAlerted`). */
  markSlaAlerted(scope: TenantScope, handoffId: string, now: Date): Promise<boolean>;
}
