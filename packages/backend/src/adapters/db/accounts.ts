// Repositório de contas WhatsApp sobre Postgres (Task 16). `setStatus`
// condicional: só devolve true quando a transição mudou algo (é o sinal para
// emitir audit/evento). Todo o SQL é parametrizado; $now = deps.now().
// Onda 1 (Task 4): CRUD/listagem sob TenantScope (o tenant é a 1.ª condição);
// findByProviderSession/findByPhone ficam SEM escopo (ruling R1 — resolução de
// tenant do webhook/job; o tenant vem do AccountRow devolvido).

import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { DbClient } from './index.js';
import { outboxMessages, whatsappAccounts } from './schema/index.js';
import type { AccountRow, AccountsRepository, OutboxStatus } from '../../ports/accounts.js';

// select explícito: a linha devolvida É um AccountRow (sem colunas extra).
const sel = {
  id: whatsappAccounts.id,
  tenantId: whatsappAccounts.tenantId, // Task 4: dono da conta (resolução de tenant)
  label: whatsappAccounts.label,
  phoneE164: whatsappAccounts.phoneE164,
  providerSessionId: whatsappAccounts.providerSessionId,
  status: whatsappAccounts.status,
  purpose: whatsappAccounts.purpose,
};

export function createAccountsRepository(deps: { db: DbClient }): AccountsRepository {
  const { db } = deps;
  return {
    async create(scope, input) {
      const [r] = await db
        .insert(whatsappAccounts)
        .values({
          label: input.label,
          purpose: input.purpose,
          providerSessionId: input.providerSessionId,
          // Onda 1 (Task 4): tenant do ADMIN autenticado (ruling R9 — o
          // hardcode interino MILVENDAS_TENANT_ID saiu daqui).
          tenantId: scope.tenantId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: whatsappAccounts.id });
      if (r === undefined) throw new Error('falhou criar conta WhatsApp');
      return { id: r.id };
    },

    async list(scope): Promise<AccountRow[]> {
      return db
        .select(sel)
        .from(whatsappAccounts)
        .where(eq(whatsappAccounts.tenantId, scope.tenantId))
        .orderBy(whatsappAccounts.createdAt);
    },

    async get(scope, id) {
      const [r] = await db
        .select(sel)
        .from(whatsappAccounts)
        .where(and(eq(whatsappAccounts.id, id), eq(whatsappAccounts.tenantId, scope.tenantId)))
        .limit(1);
      return r ?? null;
    },

    async findByProviderSession(sessionId) {
      const [r] = await db
        .select(sel)
        .from(whatsappAccounts)
        .where(eq(whatsappAccounts.providerSessionId, sessionId))
        .limit(1);
      return r ?? null;
    },

    async findByPhone(phone) {
      const [r] = await db.select(sel).from(whatsappAccounts).where(eq(whatsappAccounts.phoneE164, phone)).limit(1);
      return r ?? null;
    },

    /** Janela de falhas: por updated_at desc (id desc como desempate estável). */
    async recentOutboxStatuses(scope, accountId, limit): Promise<Array<{ status: OutboxStatus }>> {
      return db
        .select({ status: outboxMessages.status })
        .from(outboxMessages)
        .where(and(eq(outboxMessages.accountId, accountId), eq(outboxMessages.tenantId, scope.tenantId)))
        .orderBy(desc(outboxMessages.updatedAt), desc(outboxMessages.id))
        .limit(limit);
    },

    /** Só executa (e devolve true) se o estado era DIFERENTE. */
    async setStatus(scope, id, status, now) {
      const res = await db.execute(sql`
        UPDATE whatsapp_accounts
        SET status = ${status}::whatsapp_account_status, updated_at = ${now}
        WHERE id = ${id} AND tenant_id = ${scope.tenantId}::uuid
          AND status <> ${status}::whatsapp_account_status
        RETURNING id`);
      return res.rows.length > 0;
    },

    async setPhone(scope, id, phone) {
      await db
        .update(whatsappAccounts)
        .set({ phoneE164: phone })
        .where(and(eq(whatsappAccounts.id, id), eq(whatsappAccounts.tenantId, scope.tenantId)));
    },
  };
}
