// TenancyPort sobre PostgreSQL (Onda 1, Task 3): estado do tenant para o guard
// de auth (suspensão → 403 em qualquer pedido autenticado; spec §4.3).

import { eq } from 'drizzle-orm';
import type { TenancyPort } from '../../ports/tenancy.js';
import type { DbClient } from './index.js';
import { tenants } from './schema/tenants.schema.js';

export function createTenancyPort(deps: { db: DbClient }): TenancyPort {
  return {
    async getStatus(tenantId) {
      const rows = await deps.db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      return rows[0]?.status ?? null; // null = tenant inexistente (FK torna isto improvável)
    },
  };
}
