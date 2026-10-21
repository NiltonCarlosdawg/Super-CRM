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
  /** Marca que o alerta de abertura já foi emitido (sweep idempotente). */
  markOpeningAlerted(scope: TenantScope, handoffId: string, now: Date): Promise<void>;
  /** Marca que o alerta de SLA já foi emitido (sweep idempotente). */
  markSlaAlerted(scope: TenantScope, handoffId: string, now: Date): Promise<void>;
}
