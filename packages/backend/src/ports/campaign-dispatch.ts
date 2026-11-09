// Fase 4, Task 9: portas do tick de campanha. Toda a leitura/escrita é scoped
// por tenant; o envio usa a mesma outbox da Fase 1 (única saída de mensagens).

import type { Campaign, PauseReason } from '../domain/campaigns/types.js';
import type { WhatsAppAccountStub } from './campaigns.js';
import type { Outbox } from './outbox.js';
import type { TenantScope } from './tenancy.js';

export interface CampaignDispatchStore {
  /** Pendente mais antiga DESTA conta. */
  nextPending(
    scope: TenantScope,
    campaignId: string,
    accountId: string,
  ): Promise<{ id: string; contactId: string; step: number } | null>;
  /** pending → opted_out (+ opted_out_at) dos contactos sem consentimento ou com opt-out. */
  skipIneligibleContacts(scope: TenantScope, campaignId: string, at: Date): Promise<number>;
  pendingCountForAccount(scope: TenantScope, campaignId: string, accountId: string): Promise<number>;
  pendingCount(scope: TenantScope, campaignId: string): Promise<number>;
  countEnqueuedSince(scope: TenantScope, accountId: string, since: Date): Promise<number>;
}

export interface ContactNameSource {
  displayName(scope: TenantScope, contactId: string): Promise<string | null>;
}

/** A outbox da Fase 1 já tem a forma e a idempotência exigidas pelo tick. */
export type CampaignOutbox = Outbox;

export interface ConversationFinder {
  /** Conversa existente de (accountId, contactId) ou nova (line = null, ai_mode por omissão). */
  findOrCreateForCampaign(
    scope: TenantScope,
    input: { accountId: string; contactId: string },
  ): Promise<{ id: string }>;
}

export interface TickScheduler {
  /** jobId determinístico; no-op se o job já existir. */
  ensureTick(input: {
    tenantId: string;
    campaignId: string;
    accountId: string;
    runAt: Date;
  }): Promise<void>;
}

export type PauseReasonCode = PauseReason;

export type PauseGuard = (ctx: {
  campaign: Campaign;
  account: WhatsAppAccountStub;
  now: Date;
}) => Promise<{ reason: PauseReasonCode } | null>;

export interface PauseApplier {
  apply(input: {
    campaignId: string;
    reason: PauseReasonCode;
    actorId: string | null;
    now: Date;
  }): Promise<boolean>;
}
