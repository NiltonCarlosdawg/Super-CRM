// Fase 4, Task 10: estatísticas de entrega e alerta de pausa. Toda a leitura é
// scoped por tenant; 'unknown' NUNCA conta como falha (docs/04 §5).

import type { VolumeWindow } from '../domain/campaigns/auto-pause.js';
import type { PauseReason } from '../domain/campaigns/types.js';
import type { TenantScope } from './tenancy.js';

export interface DeliveryProbe {
  /** Estado da outbox por idempotency_key; 'unknown' NUNCA conta como falha (docs/04 §5). */
  outboxStates(
    scope: TenantScope,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, 'pending' | 'sent' | 'failed' | 'unknown'>>;
}

export interface RecipientStatsStore {
  /** Até `limit` linhas 'sent' com outboxKey desta conta, mais recentes primeiro. */
  sentOutboxKeys(
    scope: TenantScope,
    accountId: string,
    limit: number,
  ): Promise<readonly { id: string; outboxKey: string }[]>;
  /** status → 'failed' apenas se ainda for 'sent'. */
  markFailed(scope: TenantScope, recipientId: string, at: Date): Promise<void>;
  /** Janela desde `since`: usa campaigns.resumedAt ?? campaigns.createdAt como limiar de enqueued_at. */
  volumeWindow(
    scope: TenantScope,
    accountId: string,
    since: Date,
    input: { failWindow: number; optOutWindow: number },
  ): Promise<VolumeWindow>;
}

export interface CampaignAlertSink {
  campaignPaused(input: {
    /** Onda 1: sem tenant o evento realtime não tem sala segura (fail-closed). */
    tenantId: string;
    campaignId: string;
    accountId: string;
    reason: PauseReason;
    auto: boolean;
    at: Date;
  }): Promise<void>;
}
