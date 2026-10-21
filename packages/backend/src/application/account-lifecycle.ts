// Ciclo de vida das contas WhatsApp (Task 16; docs/04 §6): máquina de
// transições a partir dos eventos de sessão do WA-AKG. Regras:
// - audit/evento SÓ quando a transição mudou algo (setStatus condicional);
// - `logged_out` só conta como ban vindo de `connected` (admin fez logout
//   primeiro ⇒ no-op — sem qualquer automação de recuperação);
// - `suspected_ban` bloqueia envios (o worker da Task 18 não envia contas banidas);
// - janela de falhas: últimas WA_FAIL_WINDOW linhas da outbox da conta, falha
//   = estado 'failed' (timeouts 'unknown_delivery' NÃO contam, docs/04 §7).
// Onda 1 (Task 4): o scope de cada operação vem do contexto da conta resolvida
// (AccountRow.tenantId; ruling R1) — nunca de um hardcode de tenant.

import { maskPhone, normalizePhoneE164 } from '../domain/phone.js';
import type { AccountsRepository, AccountLifecycle, AccountStatus, AccountRow } from '../ports/accounts.js';
import type { Audit } from '../ports/audit.js';
import type { MessagingProvider } from '../ports/messaging-provider.js';
import type { NotifyEvent } from '../ports/notify.js';
import type { TenantScope } from '../ports/tenancy.js';

export interface AccountLifecycleDeps {
  accounts: AccountsRepository;
  provider: MessagingProvider;
  notifySink: (e: NotifyEvent) => Promise<void>;
  audit: Audit;
  cfg: { failWindow: number; failRatio: number };
  now(): Date;
  /** Opcional: só para o conflito impossível de dois `connected` com o mesmo número. */
  log?: { error(obj: unknown, msg: string): void };
}

export function createAccountLifecycle(deps: AccountLifecycleDeps): AccountLifecycle {
  const { accounts, provider, notifySink, audit, cfg, log } = deps;

  // Onda 1 (Task 4): o scope vem do contexto da conta já resolvida (ruling R1)
  // — a linha AccountRow carrega o tenant dono.
  const emit = async (account: AccountRow, to: AccountStatus, at: Date): Promise<void> => {
    const scope: TenantScope = { tenantId: account.tenantId };
    const changed = await accounts.setStatus(scope, account.id, to, at);
    if (!changed) return;
    await audit.record({
      tenantId: account.tenantId,
      actorId: null, // ação de sistema (webhook)
      action: 'account.status_changed',
      entity: 'whatsapp_account',
      entityId: account.id,
      detail: { from: account.status, to },
      at,
    });
    await notifySink({ type: 'account', tenantId: account.tenantId, accountId: account.id, status: to });
  };

  const markSuspectedBan = async (account: AccountRow, at: Date, detail: Record<string, unknown>): Promise<void> => {
    const changed = await accounts.setStatus({ tenantId: account.tenantId }, account.id, 'suspected_ban', at);
    if (!changed) return; // já banida → "uma vez" (sem audit/evento duplicado)
    await audit.record({
      tenantId: account.tenantId,
      actorId: null,
      action: 'account.suspected_ban',
      entity: 'whatsapp_account',
      entityId: account.id,
      detail,
      at,
    });
    await notifySink({ type: 'account', tenantId: account.tenantId, accountId: account.id, status: 'suspected_ban' });
  };

  return {
    async onSessionStatus(input) {
      const account = await accounts.findByProviderSession(input.sessionId);
      if (account === null) return; // sessão desconhecida: nunca inventar conta

      switch (input.status) {
        case 'connected': {
          // o número vem SEMPRE do provider (nunca do payload do webhook)
          const session = await provider.getSession(input.sessionId);
          const phone = session.phone === undefined ? null : normalizePhoneE164(session.phone);
          if (phone !== null) {
            const holder = await accounts.findByPhone(phone);
            if (holder !== null && holder.id !== account.id) {
              if (holder.status === 'connected') {
                // impossível na prática (um número só se liga a uma sessão)
                log?.error({ accountId: account.id, other: holder.id }, 'account.phone_conflict');
                await accounts.setPhone({ tenantId: account.tenantId }, account.id, null);
              } else {
                // Cada mutação usa o scope do DONO da linha que toca.
                await accounts.setPhone({ tenantId: holder.tenantId }, holder.id, null);
                await audit.record({
                  tenantId: holder.tenantId,
                  actorId: null,
                  action: 'account.phone_reassigned',
                  entity: 'whatsapp_account',
                  entityId: holder.id,
                  detail: { toAccountId: account.id, phone: maskPhone(phone) },
                  at: input.at,
                });
                await accounts.setPhone({ tenantId: account.tenantId }, account.id, phone);
              }
            } else {
              await accounts.setPhone({ tenantId: account.tenantId }, account.id, phone);
            }
          }
          await emit(account, 'connected', input.at);
          break;
        }
        case 'disconnected':
        case 'unknown':
          await emit(account, 'disconnected', input.at);
          break;
        case 'connecting':
        case 'qr_pending':
          await emit(account, 'connecting', input.at);
          break;
        case 'logged_out':
          // ban só se estava connected; outro estado = no-op (admin fez logout)
          if (account.status === 'connected') {
            await markSuspectedBan(account, input.at, { reason: 'logged_out_while_connected' });
          }
          break;
      }
    },

    async onQr(input) {
      const account = await accounts.findByProviderSession(input.sessionId);
      if (account === null) return;
      // o QR também vai por evento (docs/04 §6); o REST GET :id devolve-o por polling
      await notifySink({
        type: 'account',
        tenantId: account.tenantId, // R31: tenant dono da conta (salas por tenant)
        status: 'connecting',
        accountId: account.id,
        qr: input.qr,
      });
    },

    async recordSendResult(input) {
      // Avalia a janela já gravada na outbox (a Task 18 marca as linhas antes
      // de chamar; `ok` é informativo para o worker). Falha = estado 'failed'.
      // Onda 1 (Task 4): o scope vem do contexto da conta — o worker passa o
      // tenant da linha da outbox reivindicada (ruling R1).
      const scope: TenantScope = { tenantId: input.tenantId };
      const rows = await accounts.recentOutboxStatuses(scope, input.accountId, cfg.failWindow);
      if (rows.length < cfg.failWindow) return; // janela incompleta: nunca banir cedo
      const failed = rows.filter((r) => r.status === 'failed').length;
      // comparador ESTRICTO: 6/20 = 30% com limiar 30% NÃO bane (plano Task 16).
      if (failed / cfg.failWindow > cfg.failRatio) {
        const account = await accounts.get(scope, input.accountId);
        if (account === null) return;
        await markSuspectedBan(account, input.at, { window: cfg.failWindow, failed });
      }
    },
  };
}
