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
}
