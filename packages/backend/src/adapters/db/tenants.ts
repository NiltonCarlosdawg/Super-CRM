// Repositório de tenants (Onda 1, Task 7; spec multitenant §5.3): a
// superfície de dados da plataforma — lista com contagens (users/contas),
// ciclo de vida (suspend/activate sobre `tenants.status`) e a pergunta do
// PRIMEIRO acesso do drill auditado (`platform.view_tenant`).
// A suspensão vive SÓ em `tenants.status` — `users` não é tocado (o CHECK
// role ⇔ tenant_id fica intacto; spec §4.3).

import { and, count, eq } from 'drizzle-orm';
import type { DbClient } from './index.js';
import { auditLog } from './schema/audit.schema.js';
import { tenants } from './schema/tenants.schema.js';
import { users } from './schema/users.schema.js';
import { whatsappAccounts } from './schema/whatsapp-accounts.schema.js';

/** Estado do tenant (espelha o enum `tenant_status` da BD). */
export type TenantStatus = 'active' | 'suspended';

export interface TenantSummary {
  id: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
}

/** Linha da lista de plataforma (contrato do brief: contagens incluídas). */
export interface TenantListItem extends TenantSummary {
  usersCount: number;
  accountsCount: number;
}

export interface TenantsRepository {
  /** Lista TODOS os tenants com contagens de users e contas WhatsApp. */
  list(): Promise<TenantListItem[]>;
  /** Tenant por id; inexistente → null (o drill responde 404, nunca audit FK). */
  get(id: string): Promise<TenantSummary | null>;
  /** suspend/activate: false se o tenant não existe (nenhuma escrita). */
  setStatus(id: string, status: TenantStatus): Promise<boolean>;
  /** Task 7: o drill audita `platform.view_tenant` só no 1º acesso ao tenant —
   *  true = já houve pelo menos um acesso (o audit não se repete). */
  hasPlatformViewAudit(tenantId: string): Promise<boolean>;
}

export function createTenantsRepository(deps: { db: DbClient }): TenantsRepository {
  return {
    async list() {
      const rows = await deps.db
        .select({
          id: tenants.id,
          name: tenants.name,
          status: tenants.status,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .orderBy(tenants.createdAt, tenants.id);

      // Contagens por tenant em duas queries agregadas (GROUP BY) — um
      // leftJoin duplo multiplicaria as linhas; subqueries correlatas aqui
      // seriam SQL escrito à mão (docs/02 §5 prefere o Drizzle).
      const usersCounts = await deps.db
        .select({ tenantId: users.tenantId, value: count() })
        .from(users)
        .groupBy(users.tenantId);
      const accountsCounts = await deps.db
        .select({ tenantId: whatsappAccounts.tenantId, value: count() })
        .from(whatsappAccounts)
        .groupBy(whatsappAccounts.tenantId);
      const u = new Map(usersCounts.filter((r) => r.tenantId !== null).map((r) => [r.tenantId, r.value]));
      const a = new Map(accountsCounts.map((r) => [r.tenantId, r.value]));

      return rows.map((r) => ({
        ...r,
        usersCount: u.get(r.id) ?? 0,
        accountsCount: a.get(r.id) ?? 0,
      }));
    },

    async get(id) {
      const [row] = await deps.db
        .select({
          id: tenants.id,
          name: tenants.name,
          status: tenants.status,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .where(eq(tenants.id, id))
        .limit(1);
      return row ?? null;
    },

    async setStatus(id, status) {
      const updated = await deps.db
        .update(tenants)
        .set({ status }) // updated_at preenchido pelo $onUpdate do schema
        .where(eq(tenants.id, id))
        .returning({ id: tenants.id });
      return updated.length > 0;
    },

    async hasPlatformViewAudit(tenantId) {
      const rows = await deps.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'platform.view_tenant')))
        .limit(1);
      return rows.length > 0;
    },
  };
}
