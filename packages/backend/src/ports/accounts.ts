// Contrato de contas WhatsApp (docs/01 §6, docs/04 §6) — consumido pelo
// adaptador de BD, pelo ciclo de vida (application) e pelas rotas admin.

import type { SessionStatus } from './messaging-provider.js';
import type { TenantScope } from './tenancy.js';

/** docs/04 §6: estados GUARDADOS em whatsapp_accounts.status. */
export type AccountStatus = 'connecting' | 'connected' | 'disconnected' | 'suspected_ban';

export type AccountPurpose = 'support' | 'sales' | 'campaigns';

export interface AccountRow {
  id: string;
  /** Onda 1 (Task 4): dono da conta — as buscas sem escopo (webhook/jobs,
   *  ruling R1) resolvem aqui o tenant para as operações seguintes. */
  tenantId: string;
  label: string;
  /** Anulável (docs/04 §6): null = número ainda não associado ou removido. */
  phoneE164: string | null;
  providerSessionId: string;
  status: AccountStatus;
  purpose: AccountPurpose;
}

/** docs/04 §5: estados da outbox (espelha o enum da BD). */
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown_delivery';

export interface AccountsRepository {
  /** Onda 1 (Task 4): todo o CRUD/listagem opera SOB um TenantScope — a
   *  conta nasce no tenant do utilizador autenticado (substitui o hardcode
   *  interino MILVENDAS_TENANT_ID, ruling R9). `get` de conta alheia → null
   *  (cross-tenant esconde a existência; nunca 403). */
  create(scope: TenantScope, input: {
    label: string;
    purpose: AccountPurpose;
    providerSessionId: string;
    now: Date;
  }): Promise<{ id: string }>;
  list(scope: TenantScope): Promise<AccountRow[]>;
  get(scope: TenantScope, id: string): Promise<AccountRow | null>;
  /** Ruling R1: ponto de resolução de tenant do webhook/job — SEM TenantScope;
   *  o tenant do chamador vem do AccountRow devolvido. */
  findByProviderSession(sessionId: string): Promise<AccountRow | null>;
  /** Extra à lista do plano: o fluxo de reconexão precisa de achar quem TEM o telefone.
   *  Ruling R1: SEM TenantScope (resolução de tenant, como findByProviderSession). */
  findByPhone(phone: string): Promise<AccountRow | null>;
  /** Extra à lista do plano: últimas N linhas da outbox da conta (updated_at desc) — janela de falhas.
   *  Ruling R1: o chamador passa o scope do contexto da conta já resolvida. */
  recentOutboxStatuses(scope: TenantScope, accountId: string, limit: number): Promise<Array<{ status: OutboxStatus }>>;
  /** false se já nesse estado — audit/evento só quando a transição mudou algo. */
  setStatus(scope: TenantScope, id: string, status: AccountStatus, now: Date): Promise<boolean>;
  setPhone(scope: TenantScope, id: string, phone: string | null): Promise<void>;
}

/** Ciclo de vida consumido pelo job de webhook (Task 19). */
export interface AccountLifecycle {
  onSessionStatus(input: { sessionId: string; status: SessionStatus; at: Date }): Promise<void>;
  onQr(input: { sessionId: string; qr: string; at: Date }): Promise<void>;
  /** Falha = estado 'failed' na outbox; a janela é a das últimas N linhas da conta.
   *  `tenantId` vem da linha da outbox reivindicada (o worker; Task 4). */
  recordSendResult(input: { accountId: string; tenantId: string; ok: boolean; at: Date }): Promise<void>;
}
