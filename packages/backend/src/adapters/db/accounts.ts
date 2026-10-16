// Repositório de contas WhatsApp sobre Postgres (Task 16). `setStatus`
// condicional: só devolve true quando a transição mudou algo (é o sinal para
// emitir audit/evento). Todo o SQL é parametrizado; $now = deps.now().

import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { DbClient } from './index.js';
import { MILVENDAS_TENANT_ID, outboxMessages, whatsappAccounts } from './schema/index.js';
import type { AccountRow, AccountsRepository, OutboxStatus } from '../../ports/accounts.js';

// select explícito: a linha devolvida É um AccountRow (sem colunas extra).
const sel = {
  id: whatsappAccounts.id,
  label: whatsappAccounts.label,
  phoneE164: whatsappAccounts.phoneE164,
  providerSessionId: whatsappAccounts.providerSessionId,
  status: whatsappAccounts.status,
  purpose: whatsappAccounts.purpose,
};

export function createAccountsRepository(deps: { db: DbClient }): AccountsRepository {
  const { db } = deps;
  return {
    async create(input) {
      const [r] = await db
        .insert(whatsappAccounts)
        .values({
          label: input.label,
          purpose: input.purpose,
          providerSessionId: input.providerSessionId,
          // Onda 1 (Task 1): tenant fixo até o escopo chegar pela sessão (Tasks 3–5).
          tenantId: MILVENDAS_TENANT_ID,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: whatsappAccounts.id });
      if (r === undefined) throw new Error('falhou criar conta WhatsApp');
      return { id: r.id };
    },

    async list(): Promise<AccountRow[]> {
      return db.select(sel).from(whatsappAccounts).orderBy(whatsappAccounts.createdAt);
    },

    async get(id) {
      const [r] = await db.select(sel).from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).limit(1);
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
    async recentOutboxStatuses(accountId, limit): Promise<Array<{ status: OutboxStatus }>> {
      return db
        .select({ status: outboxMessages.status })
        .from(outboxMessages)
        .where(eq(outboxMessages.accountId, accountId))
        .orderBy(desc(outboxMessages.updatedAt), desc(outboxMessages.id))
        .limit(limit);
    },

    /** Só executa (e devolve true) se o estado era DIFERENTE. */
    async setStatus(id, status, now) {
      const res = await db.execute(sql`
        UPDATE whatsapp_accounts
        SET status = ${status}::whatsapp_account_status, updated_at = ${now}
        WHERE id = ${id} AND status <> ${status}::whatsapp_account_status
        RETURNING id`);
      return res.rows.length > 0;
    },

    async setPhone(id, phone) {
      await db.update(whatsappAccounts).set({ phoneE164: phone }).where(eq(whatsappAccounts.id, id));
    },
  };
}
