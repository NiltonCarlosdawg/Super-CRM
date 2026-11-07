// Fase 4, Task 2: fonte única dos enums e tipos das campanhas.
// O esquema real vive em `adapters/db/schema/campaigns.schema.ts` (Onda 1) e as
// contas permitidas são a junção `campaign_accounts`, não uma coluna de array.

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = ['pending', 'sent', 'failed', 'replied', 'opted_out'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const PAUSE_REASONS = ['failure_rate', 'session_down', 'opt_out_spike', 'human'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  status: CampaignStatus;
  messageTemplate: string;
  allowedAccountIds: string[];
  dailyLimit: number | null;
  scheduledAt: Date | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  pausedBy: string | null;
  resumedBy: string | null;
  resumedAt: Date | null;
  createIdempotencyKey: string | null;
  createRequestHash: string | null;
  startIdempotencyKey: string | null;
  startRequestHash: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCampaign {
  id: string;
  tenantId: string;
  name: string;
  messageTemplate: string;
  allowedAccountIds: string[];
  dailyLimit: number | null;
  createdBy: string;
  createIdempotencyKey: string;
  createRequestHash: string;
}

export interface CampaignRecipient {
  id: string;
  tenantId: string;
  campaignId: string;
  contactId: string;
  accountId: string;
  step: number;
  status: RecipientStatus;
  outboxKey: string | null;
  enqueuedAt: Date | null;
  repliedAt: Date | null;
  optedOutAt: Date | null;
  createdAt: Date;
}
