// Fase 4, Task 6: destinatários materializados de uma campanha, sempre scoped
// por tenant. A materialização é idempotente por (campaign, contact, step).

import type { TenantScope } from './tenancy.js';

export interface NewRecipient {
  id: string;
  campaignId: string;
  contactId: string;
  accountId: string;
  step: number;
}

export interface CampaignRecipientStore {
  /** Idempotente: ON CONFLICT (campaign_id, contact_id, step) DO NOTHING. Devolve nº de linhas novas. */
  insertBatch(scope: TenantScope, rows: readonly NewRecipient[]): Promise<number>;
  countByCampaign(scope: TenantScope, campaignId: string): Promise<number>;
  /** pendente → sent: preenche outboxKey e enqueuedAt. Devolve true só se mudou (idempotente). */
  markEnqueued(scope: TenantScope, recipientId: string, outboxKey: string, at: Date): Promise<boolean>;
  /** pending → opted_out; sent/replied/failed só levam opted_out_at. Devolve o nº de pendentes que mudaram. Idempotente. */
  markOptedOutByContact(scope: TenantScope, contactId: string, at: Date): Promise<number>;
  /** sent → replied (só se replied_at for null). Devolve nº de linhas. */
  markRepliedByContact(scope: TenantScope, contactId: string, at: Date): Promise<number>;
  /** optedOut = linhas com opted_out_at NOT NULL (pode sobrepor-se a sent/replied). */
  counts(
    scope: TenantScope,
    campaignId: string,
  ): Promise<{ pending: number; sent: number; failed: number; replied: number; optedOut: number }>;
}
