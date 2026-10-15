// Contrato de contas WhatsApp (docs/01 §6, docs/04 §6) — consumido pelo
// adaptador de BD, pelo ciclo de vida (application) e pelas rotas admin.

import type { SessionStatus } from './messaging-provider.js';

/** docs/04 §6: estados GUARDADOS em whatsapp_accounts.status. */
export type AccountStatus = 'connecting' | 'connected' | 'disconnected' | 'suspected_ban';

export type AccountPurpose = 'support' | 'sales' | 'campaigns';

export interface AccountRow {
  id: string;
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
  create(input: {
    label: string;
    purpose: AccountPurpose;
    providerSessionId: string;
    now: Date;
  }): Promise<{ id: string }>;
  list(): Promise<AccountRow[]>;
  get(id: string): Promise<AccountRow | null>;
  findByProviderSession(sessionId: string): Promise<AccountRow | null>;
  /** Extra à lista do plano: o fluxo de reconexão precisa de achar quem TEM o telefone. */
  findByPhone(phone: string): Promise<AccountRow | null>;
  /** Extra à lista do plano: últimas N linhas da outbox da conta (updated_at desc) — janela de falhas. */
  recentOutboxStatuses(accountId: string, limit: number): Promise<Array<{ status: OutboxStatus }>>;
  /** false se já nesse estado — audit/evento só quando a transição mudou algo. */
  setStatus(id: string, status: AccountStatus, now: Date): Promise<boolean>;
  setPhone(id: string, phone: string | null): Promise<void>;
}

/** Ciclo de vida consumido pelo job de webhook (Task 19). */
export interface AccountLifecycle {
  onSessionStatus(input: { sessionId: string; status: SessionStatus; at: Date }): Promise<void>;
  onQr(input: { sessionId: string; qr: string; at: Date }): Promise<void>;
  /** Falha = estado 'failed' na outbox; a janela é a das últimas N linhas da conta. */
  recordSendResult(input: { accountId: string; ok: boolean; at: Date }): Promise<void>;
}
