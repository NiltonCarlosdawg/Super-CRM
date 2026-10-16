// Adaptador de auditoria (docs/01 §6): um INSERT parametrizado em audit_log.
// Erros de escrita são propagados, nunca engolidos (docs/02 §3).

import type { Audit } from '../../ports/audit.js';
import type { DbClient } from './index.js';
import { auditLog } from './schema/audit.schema.js';

export function createAuditAdapter(deps: { db: DbClient }): Audit {
  return {
    async record(input) {
      // `audit_log` não tem coluna `entity` (docs/01 §6): o nome lógico da
      // entidade é guardado em `details` para nada se perder no histórico.
      const details = { entity: input.entity, ...(input.detail ?? {}) };
      await deps.db.insert(auditLog).values({
        // Onda 1 (Task 4): dono do registo — null só para ações de
        // plataforma/sistema sem tenant (spec §4.2).
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.action,
        entityId: input.entityId,
        ip: input.ip ?? null,
        details,
        createdAt: input.at,
      });
    },
  };
}
