// Fila de handoffs sobre Postgres (Fase 3, Task 14; ADR-0003 A6.1, A10).
// O `claim` é um único UPDATE atómico `WHERE status='pending' RETURNING id` —
// sem linha devolvida, outro humano já venceu ('taken') ou não existe
// ('not_found'). Todo o SQL leva `AND tenant_id` (Onda 1, spec §4.3).
//
// `get`/`listPending` usam o query builder (mesmo padrão de conversations.ts):
// devolve colunas tipadas (uuid → string, timestamptz → Date, jsonb → objeto),
// sem casts manuais. Só os `UPDATE … RETURNING` atómicos usam SQL cru.

import { and, asc, eq, sql } from 'drizzle-orm';

import type { AiMode, LineSlug } from '../../ports/ai-provider.js';
import type { TenantScope } from '../../ports/tenancy.js';
import type { HandoffQueueRepository, HandoffRow } from '../../ports/handoff-queue.js';
import type { HandoffConversations } from '../../application/handoffs.js';
import { handoffs } from '../../modules/knowledge/knowledge.schema.js';
import type { DbClient } from './index.js';

/** Vocabulário de linhas do domínio (docs/01 §6) — slug fora disto é null, nunca se adivinha. */
const LINE_SLUGS: readonly string[] = ['software', 'custom', 'telecom', 'cctv'];

type HandoffDbRow = typeof handoffs.$inferSelect;

function toRow(r: HandoffDbRow): HandoffRow {
  return {
    id: r.id,
    conversationId: r.conversationId,
    status: r.status,
    priority: r.priority,
    createdAt: r.createdAt,
    openingAlertedAt: r.openingAlertedAt,
    slaAlertedAt: r.slaAlertedAt,
    summary: r.summary,
    reason: r.reason,
    leadSnapshot: r.leadSnapshot ?? null,
  };
}

export function createHandoffQueueRepository(db: DbClient): HandoffQueueRepository {
  return {
    async claim(scope: TenantScope, handoffId: string, userId: string, now: Date) {
      const res = await db.execute(sql`
        UPDATE handoffs SET status = 'accepted', accepted_by_id = ${userId}::uuid, accepted_at = ${now}::timestamptz
        WHERE id = ${handoffId}::uuid AND tenant_id = ${scope.tenantId}::uuid AND status = 'pending'
        RETURNING id`);
      if (res.rows.length > 0) return 'claimed';
      const exists = await db.execute(sql`
        SELECT 1 FROM handoffs WHERE id = ${handoffId}::uuid AND tenant_id = ${scope.tenantId}::uuid`);
      return exists.rows.length > 0 ? ('taken' as const) : ('not_found' as const);
    },

    async get(scope: TenantScope, handoffId: string) {
      const [row] = await db
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.id, handoffId), eq(handoffs.tenantId, scope.tenantId)))
        .limit(1);
      return row === undefined ? null : toRow(row);
    },

    async resolve(scope: TenantScope, handoffId: string, _userId: string, now: Date) {
      const res = await db.execute(sql`
        UPDATE handoffs SET status = 'resolved', resolved_at = ${now}::timestamptz
        WHERE id = ${handoffId}::uuid AND tenant_id = ${scope.tenantId}::uuid AND status IN ('pending', 'accepted')
        RETURNING id`);
      return res.rows.length > 0 ? ('resolved' as const) : ('not_found' as const);
    },

    /** Prioridade é o enum (urgent, high, normal) — ORDER BY dá urgent primeiro; empate por mais antigo. */
    async listPending(scope: TenantScope, limit: number) {
      const rows = await db
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.tenantId, scope.tenantId), eq(handoffs.status, 'pending')))
        .orderBy(asc(handoffs.priority), asc(handoffs.createdAt))
        .limit(limit);
      return rows.map(toRow);
    },

    async markOpeningAlerted(scope: TenantScope, handoffId: string, now: Date) {
      await db.execute(sql`
        UPDATE handoffs SET opening_alerted_at = ${now}::timestamptz
        WHERE id = ${handoffId}::uuid AND tenant_id = ${scope.tenantId}::uuid`);
    },

    async markSlaAlerted(scope: TenantScope, handoffId: string, now: Date) {
      await db.execute(sql`
        UPDATE handoffs SET sla_alerted_at = ${now}::timestamptz
        WHERE id = ${handoffId}::uuid AND tenant_id = ${scope.tenantId}::uuid`);
    },
  };
}

/** getLine/setAiMode sob scope — superfície que os casos de uso de handoff precisam. */
export function createHandoffConversations(db: DbClient): HandoffConversations {
  return {
    async getLine(scope: TenantScope, conversationId: string) {
      const res = await db.execute(sql`
        SELECT bl.slug FROM conversations c
        LEFT JOIN business_lines bl ON bl.id = c.line_id
        WHERE c.id = ${conversationId}::uuid AND c.tenant_id = ${scope.tenantId}::uuid`);
      const slug = (res.rows[0] as { slug: string | null } | undefined)?.slug;
      if (slug === null || slug === undefined) return null;
      return LINE_SLUGS.includes(slug) ? (slug as LineSlug) : null;
    },

    async setAiMode(scope: TenantScope, conversationId: string, mode: AiMode) {
      await db.execute(sql`
        UPDATE conversations SET ai_mode = ${mode}::ai_mode
        WHERE id = ${conversationId}::uuid AND tenant_id = ${scope.tenantId}::uuid`);
    },
  };
}
