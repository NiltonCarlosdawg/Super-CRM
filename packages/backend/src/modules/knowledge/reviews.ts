// Fase 2 Task 3 (design §5): revisão periódica do conhecimento publicado.
// Vencido = status='published' e COALESCE(reviewed_at, updated_at) +
// review_every_days dias <= now (§5.2); itens expirados continuam na lista mas
// não são servidos pelo retrieve (filtros de validade desse lado). As leituras
// usam SQL directo porque cruzam as três tabelas numa só; o cálculo é puro e
// unit-testável. Tudo tenant-scoped.

import { and, eq, sql } from 'drizzle-orm';

import { HttpError } from '../../adapters/http/errors.js';
import { catalogItems, knowledgeDocs, rules } from './knowledge.schema.js';
import type { TrainDeps } from './train-service.js';

export type ReviewEntityType = 'catalog_item' | 'knowledge_doc' | 'rule';

const MS_PER_DAY = 86_400_000;

export interface ReviewDueBase {
  reviewedAt: Date | null;
  updatedAt: Date;
  reviewEveryDays: number;
}

/** Quando a revisão vence: a última revisão, ou a edição se nunca revisto. */
export function dueAt(row: ReviewDueBase): Date {
  const base = row.reviewedAt ?? row.updatedAt;
  return new Date(base.getTime() + row.reviewEveryDays * MS_PER_DAY);
}

/** Dias em atraso (negativo = ainda não venceu), arredondados por baixo. */
export function daysOverdue(due: Date, now: Date): number {
  return Math.floor((now.getTime() - due.getTime()) / MS_PER_DAY);
}

export interface ReviewItem {
  entityType: ReviewEntityType;
  id: string;
  slug: string;
  title: string;
  lineSlug: string | null;
  reviewedAt: Date | null;
  reviewEveryDays: number;
  daysOverdue: number;
  validUntil: Date | null;
}

/** Linha normalizada das três tabelas (as colunas de revisão são iguais). */
interface ReviewRow {
  entity_type: string;
  id: string;
  slug: string;
  title: string;
  line_slug: string | null;
  status: string;
  reviewed_at: Date | null;
  updated_at: Date;
  review_every_days: number;
  valid_until: Date | null;
}

/** O SQL directo devolve os timestamps como string (ou Date, conforme o driver). */
type RawReviewRow = Omit<ReviewRow, 'reviewed_at' | 'updated_at' | 'valid_until'> & {
  reviewed_at: string | Date | null;
  updated_at: string | Date;
  valid_until: string | Date | null;
};

/** Leitura única das três tabelas (`status` livre para a marcação, `limit` para a lista). */
async function selectReviewRows(
  deps: TrainDeps,
  filter: { id?: string; publishedOnly: boolean },
): Promise<ReviewRow[]> {
  const tenantId = deps.scope.tenantId;
  const id = filter.id ?? null;
  const status = filter.publishedOnly ? sql` AND status = 'published'` : sql``;
  // `id` é ambíguo com o LEFT JOIN em business_lines: qualificar por tabela.
  const byIdC = filter.id === undefined ? sql`` : sql` AND c.id = ${id}`;
  const byIdD = filter.id === undefined ? sql`` : sql` AND d.id = ${id}`;
  const byIdR = filter.id === undefined ? sql`` : sql` AND r.id = ${id}`;
  const res = await deps.db.execute(sql`
    SELECT 'catalog_item' AS entity_type, c.id, c.slug, c.name AS title, bl.slug AS line_slug,
      c.status, c.reviewed_at, c.updated_at, c.review_every_days, c.valid_until
    FROM catalog_items c LEFT JOIN business_lines bl ON bl.id = c.line_id
    WHERE c.tenant_id = ${tenantId}${byIdC}${status}
    UNION ALL
    SELECT 'knowledge_doc', d.id, d.slug, d.title, bl.slug,
      d.status, d.reviewed_at, d.updated_at, d.review_every_days, d.valid_until
    FROM knowledge_docs d LEFT JOIN business_lines bl ON bl.id = d.line_id
    WHERE d.tenant_id = ${tenantId}${byIdD}${status}
    UNION ALL
    SELECT 'rule', r.id, r.slug, r.title, bl.slug,
      r.status, r.reviewed_at, r.updated_at, r.review_every_days, r.valid_until
    FROM rules r LEFT JOIN business_lines bl ON bl.id = r.line_id
    WHERE r.tenant_id = ${tenantId}${byIdR}${status}
    ${filter.id === undefined ? sql`` : sql`LIMIT 1`}`);
  return (res.rows as unknown as RawReviewRow[]).map((row) => ({
    ...row,
    reviewed_at: row.reviewed_at === null ? null : new Date(row.reviewed_at),
    updated_at: new Date(row.updated_at),
    valid_until: row.valid_until === null ? null : new Date(row.valid_until),
  }));
}

/** Item vencido, ou null quando ainda está dentro da cadência. */
function toOverdueItem(row: ReviewRow, now: Date): ReviewItem | null {
  const overdue = daysOverdue(
    dueAt({
      reviewedAt: row.reviewed_at,
      updatedAt: row.updated_at,
      reviewEveryDays: row.review_every_days,
    }),
    now,
  );
  if (overdue < 0) return null;
  return {
    entityType: row.entity_type as ReviewEntityType,
    id: row.id,
    slug: row.slug,
    title: row.title,
    lineSlug: row.line_slug,
    reviewedAt: row.reviewed_at,
    reviewEveryDays: row.review_every_days,
    daysOverdue: overdue,
    validUntil: row.valid_until,
  };
}

/** Itens vencidos dos três tipos, do mais atrasado para o menos, com limite. */
export async function listOverdueReviews(deps: TrainDeps, limit = 50): Promise<ReviewItem[]> {
  const now = deps.now();
  const rows = await selectReviewRows(deps, { publishedOnly: true });
  const items = rows
    .map((row) => toOverdueItem(row, now))
    .filter((item): item is ReviewItem => item !== null)
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.slug.localeCompare(b.slug));
  return items.slice(0, limit);
}

/** Marca um item como revisto (`reviewed_at = now`) e devolve-o. */
export async function markReviewed(
  deps: TrainDeps,
  input: { entityType: ReviewEntityType; id: string; actorId: string },
): Promise<ReviewItem> {
  const now = deps.now();
  const tenantId = deps.scope.tenantId;
  const rows = await selectReviewRows(deps, { id: input.id, publishedOnly: false });
  const row = rows.find((candidate) => candidate.entity_type === input.entityType);
  if (row === undefined) throw new HttpError(404, 'item_not_found', 'item inexistente');
  if (row.status !== 'published') {
    throw new HttpError(409, 'not_published', 'só itens publicados são revistos');
  }

  const overdue = Math.max(
    0,
    daysOverdue(
      dueAt({
        reviewedAt: row.reviewed_at,
        updatedAt: row.updated_at,
        reviewEveryDays: row.review_every_days,
      }),
      now,
    ),
  );

  switch (input.entityType) {
    case 'catalog_item':
      await deps.db
        .update(catalogItems)
        .set({ reviewedAt: now })
        .where(and(eq(catalogItems.id, input.id), eq(catalogItems.tenantId, tenantId)));
      break;
    case 'knowledge_doc':
      await deps.db
        .update(knowledgeDocs)
        .set({ reviewedAt: now })
        .where(and(eq(knowledgeDocs.id, input.id), eq(knowledgeDocs.tenantId, tenantId)));
      break;
    case 'rule':
      await deps.db
        .update(rules)
        .set({ reviewedAt: now })
        .where(and(eq(rules.id, input.id), eq(rules.tenantId, tenantId)));
      break;
  }

  await deps.audit.record({
    tenantId,
    actorId: input.actorId,
    action: 'knowledge.reviewed',
    entity: input.entityType,
    entityId: input.id,
    detail: { entityType: input.entityType, id: input.id, daysOverdue: overdue },
    at: now,
  });

  return {
    entityType: input.entityType,
    id: row.id,
    slug: row.slug,
    title: row.title,
    lineSlug: row.line_slug,
    reviewedAt: now,
    reviewEveryDays: row.review_every_days,
    daysOverdue: 0,
    validUntil: row.valid_until,
  };
}
