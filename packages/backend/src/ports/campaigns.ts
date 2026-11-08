// Fase 4: portas do módulo de campanhas. Toda a leitura/escrita de negócio é
// scoped por tenant (Onda 1, spec §4.3); o adaptador recebe o `TenantScope`.

import type { Campaign, CampaignStatus, NewCampaign, PauseReason } from '../domain/campaigns/types.js';
import type { TenantScope } from './tenancy.js';

export type AccountPurpose = 'support' | 'sales' | 'campaigns';
export type AccountStatus = 'connecting' | 'connected' | 'disconnected' | 'suspected_ban';

export interface WhatsAppAccountStub {
  id: string;
  purpose: AccountPurpose;
  status: AccountStatus;
  createdAt: Date;
}

export interface AccountGate {
  find(scope: TenantScope, ids: readonly string[]): Promise<readonly WhatsAppAccountStub[]>;
}

export interface StatusPatch {
  status: CampaignStatus;
  pauseReason?: PauseReason | null;
  pausedAt?: Date | null;
  pausedBy?: string | null;
  resumedBy?: string | null;
  resumedAt?: Date | null;
  scheduledAt?: Date | null;
  startIdempotencyKey?: string;
  startRequestHash?: string;
}

export interface CampaignRepository {
  insert(scope: TenantScope, campaign: NewCampaign): Promise<Campaign>;
  findById(scope: TenantScope, id: string): Promise<Campaign | null>;
  findByIdempotencyKey(scope: TenantScope, key: string): Promise<Campaign | null>;
  list(
    scope: TenantScope,
    input: { limit: number; cursor: string | null },
  ): Promise<{ items: Campaign[]; nextCursor: string | null }>;
  /** Transição condicional (FOR UPDATE): só aplica se o estado atual estiver em `expected`. */
  compareAndSetStatus(
    scope: TenantScope,
    id: string,
    expected: readonly CampaignStatus[],
    patch: StatusPatch,
  ): Promise<Campaign | null>;
}
