// Treinar agente, Task 6: diff do rascunho contra o activo e publicação
// atómica aditiva numa única transacção (spec §5–§6).
//
// Regras que este serviço garante:
// - "novo prevalece, não tocado permanece": só as entradas do diff mudam;
//   ausência no rascunho nunca arquiva nada (isso exige `op: 'delete'`).
// - Conflitos de versão e linhas por confirmar bloqueiam com 409/422 e o
//   payload responde com a lista (as rotas traduzem para problem+json).
// - Idempotência pelo digest sha256 do conteúdo staged: repetir a validação
//   devolve a publicação existente (`idempotent: true`), inclusive em corrida
//   (o unique `(tenantId, idempotencyKey)` é a rede → SQLSTATE 23505).
// - Tudo (publicação, itens, revisões e limpeza do staging) na mesma transacção.
//
// Fixtures e conteúdo vêm sempre do tenant do scope; cross-tenant não vê nada.

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DbClient } from '../../adapters/db/index.js';
import { HttpError } from '../../adapters/http/errors.js';
import type { DiffEntry } from './diff.js';
import { canonicalPayload, computeDraftDiff, stagedCanonical } from './diff.js';
import {
  businessLines,
  catalogItems,
  knowledgeChunks,
  knowledgeDocs,
  knowledgeDraftItems,
  knowledgePublications,
  knowledgeRevisions,
  rules,
  type DraftEntityType,
  type StagedItemRow,
} from './knowledge.schema.js';
import {
  listDraftItems,
  resolveLineId,
  TrainServiceError,
  type StagedChunk,
  type TrainDeps,
} from './train-service.js';

/** Contagens aplicadas por uma publicação (`applied` jsonb). */
export interface AppliedCounts {
  added: number;
  updated: number;
  archived: number;
}

export interface DiffDraftResult {
  entries: DiffEntry[];
  unconfirmedSlugs: string[];
  digest: string;
}

export interface ValidateDraftResult {
  publicationId: string;
  applied: AppliedCounts;
  idempotent: boolean;
}

export interface ValidateDraftInput {
  changedById: string;
  acceptConflicts?: string[];
}

/** Cliente de transacção derivado do DbClient (sem exportar tipos do Drizzle). */
type TxClient = Parameters<Parameters<DbClient['transaction']>[0]>[0];

const CATALOG_KINDS = ['product', 'service', 'plan', 'package'] as const;
const DOC_TYPES = ['faq', 'policy', 'process', 'company_info', 'objection'] as const;
const RULE_KINDS = ['may_promise', 'must_not_claim', 'discount_limit', 'payment_terms', 'tone'] as const;

const catalogPayloadSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).nullish(),
  pricingMode: z.enum(['fixed', 'from', 'quote_only']),
  priceAmount: z.string().nullish(),
  currency: z.string().min(1).optional(),
  priceNote: z.string().nullish(),
  availability: z.enum(['available', 'limited', 'unavailable']).optional(),
  // O extractor usa `kind: 'catalog_item'`; a coluna publicada usa
  // product/service/plan/package. Só a segunda é aceite no insert.
  kind: z.string().optional(),
});

const docPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  type: z.enum(DOC_TYPES).optional(),
  docType: z.enum(DOC_TYPES).optional(),
});

const rulePayloadSchema = z.object({
  title: z.string().min(1),
  instruction: z.string(),
  params: z.record(z.string(), z.unknown()).nullish(),
  ruleKind: z.enum(RULE_KINDS).optional(),
  kind: z.string().optional(),
});

// Chunks calculados na extracção (T2/T4): conteúdo + vetor (null sem embedder).
const stagedChunkSchema = z.object({
  position: z.number().int().nonnegative(),
  content: z.string().min(1),
  embedding: z.array(z.number()).nullable(),
});
const stagedChunksSchema = z.array(stagedChunkSchema);

/** Valores já normalizados para insert/update e para o snapshot da revisão. */
type StagedValues =
  | {
      entityType: 'catalog_item';
      catalog: {
        name: string;
        summary: string;
        details: Record<string, unknown> | null;
        pricingMode: 'fixed' | 'from' | 'quote_only';
        priceAmount: string | null;
        currency: string;
        priceNote: string | null;
        availability: 'available' | 'limited' | 'unavailable';
        kind: (typeof CATALOG_KINDS)[number];
      };
    }
  | {
      entityType: 'knowledge_doc';
      doc: { title: string; body: string; type: (typeof DOC_TYPES)[number] };
    }
  | {
      entityType: 'rule';
      rule: {
        title: string;
        instruction: string;
        params: Record<string, unknown> | null;
        kind: (typeof RULE_KINDS)[number];
      };
    };

/** Item activo carregado para comparação e para o snapshot "prévio". */
interface PublishedEntity {
  entityType: DraftEntityType;
  slug: string;
  rowId: string;
  version: number;
  lineSlug: string | null;
  fields: Record<string, unknown>;
  canonical: string;
}

type PlannedWrite =
  | {
      action: 'insert';
      entry: DiffEntry;
      staged: StagedItemRow;
      values: StagedValues;
      chunks: StagedChunk[];
    }
  | {
      action: 'update';
      entry: DiffEntry;
      staged: StagedItemRow;
      published: PublishedEntity;
      values: StagedValues;
      chunks: StagedChunk[];
    }
  | { action: 'archive'; entry: DiffEntry; staged: StagedItemRow; published: PublishedEntity };

const keyOf = (entityType: string, slug: string): string => `${entityType}:${slug}`;

function invalidPayload(field: string): HttpError {
  return new HttpError(422, 'invalid_draft_payload', `payload staged inválido em '${field}'`);
}

/** Traduz o payload staged (T3) para os campos editáveis por tipo. */
function parseStagedValues(entityType: DraftEntityType, payload: unknown): StagedValues {
  switch (entityType) {
    case 'catalog_item': {
      const parsed = catalogPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw invalidPayload(parsed.error.issues[0]?.path.join('.') || '(raiz)');
      }
      const value = parsed.data;
      const kind =
        typeof value.kind === 'string' &&
        (CATALOG_KINDS as readonly string[]).includes(value.kind)
          ? (value.kind as (typeof CATALOG_KINDS)[number])
          : 'service';
      return {
        entityType,
        catalog: {
          name: value.name,
          summary: value.summary,
          details: value.details ?? null,
          pricingMode: value.pricingMode,
          priceAmount: value.priceAmount ?? null,
          currency: value.currency ?? 'AOA',
          priceNote: value.priceNote ?? null,
          availability: value.availability ?? 'available',
          kind,
        },
      };
    }
    case 'knowledge_doc': {
      const parsed = docPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw invalidPayload(parsed.error.issues[0]?.path.join('.') || '(raiz)');
      }
      const type = parsed.data.type ?? parsed.data.docType;
      if (type === undefined) throw invalidPayload('type');
      return { entityType, doc: { title: parsed.data.title, body: parsed.data.body, type } };
    }
    case 'rule': {
      const parsed = rulePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw invalidPayload(parsed.error.issues[0]?.path.join('.') || '(raiz)');
      }
      const kind =
        parsed.data.ruleKind ??
        (typeof parsed.data.kind === 'string' &&
        (RULE_KINDS as readonly string[]).includes(parsed.data.kind)
          ? (parsed.data.kind as (typeof RULE_KINDS)[number])
          : undefined);
      if (kind === undefined) throw invalidPayload('ruleKind');
      return {
        entityType,
        rule: {
          title: parsed.data.title,
          instruction: parsed.data.instruction,
          params: parsed.data.params ?? null,
          kind,
        },
      };
    }
  }
}

/** Chunks do staging validados para materialização em `knowledge_chunks`. */
function parseStagedChunks(value: unknown): StagedChunk[] {
  if (value === null || value === undefined) return [];
  const parsed = stagedChunksSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidPayload(parsed.error.issues[0]?.path.join('.') || 'chunks');
  }
  return parsed.data;
}

/** Snapshot da revisão: só o estado editável + a linha (para edição rápida e reversão). */
function snapshotOf(values: StagedValues, lineSlug: string | null): Record<string, unknown> {
  switch (values.entityType) {
    case 'catalog_item':
      return {
        name: values.catalog.name,
        summary: values.catalog.summary,
        details: values.catalog.details,
        pricingMode: values.catalog.pricingMode,
        priceAmount: values.catalog.priceAmount,
        currency: values.catalog.currency,
        priceNote: values.catalog.priceNote,
        availability: values.catalog.availability,
        lineSlug,
      };
    case 'knowledge_doc':
      return { ...values.doc, lineSlug };
    case 'rule':
      return {
        title: values.rule.title,
        instruction: values.rule.instruction,
        params: values.rule.params,
        lineSlug,
      };
  }
}

/** Carga dos activos dos três tipos, com a linha resolvida por join. */
async function loadPublished(deps: TrainDeps): Promise<PublishedEntity[]> {
  const tenantId = deps.scope.tenantId;
  const out: PublishedEntity[] = [];

  const catalogRows = await deps.db
    .select({ row: catalogItems, lineSlug: businessLines.slug })
    .from(catalogItems)
    .leftJoin(businessLines, eq(businessLines.id, catalogItems.lineId))
    .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.status, 'published')));
  for (const { row, lineSlug } of catalogRows) {
    const fields: Record<string, unknown> = {
      name: row.name,
      summary: row.summary,
      details: row.details,
      pricingMode: row.pricingMode,
      priceAmount: row.priceAmount,
      currency: row.currency,
      priceNote: row.priceNote,
      availability: row.availability,
      kind: row.kind,
    };
    out.push({
      entityType: 'catalog_item',
      slug: row.slug,
      rowId: row.id,
      version: row.version,
      lineSlug: lineSlug ?? null,
      fields,
      canonical: canonicalPayload('catalog_item', { ...fields, lineSlug: lineSlug ?? null }),
    });
  }

  const docRows = await deps.db
    .select({ row: knowledgeDocs, lineSlug: businessLines.slug })
    .from(knowledgeDocs)
    .leftJoin(businessLines, eq(businessLines.id, knowledgeDocs.lineId))
    .where(and(eq(knowledgeDocs.tenantId, tenantId), eq(knowledgeDocs.status, 'published')));
  for (const { row, lineSlug } of docRows) {
    const fields: Record<string, unknown> = { title: row.title, body: row.body, type: row.type };
    out.push({
      entityType: 'knowledge_doc',
      slug: row.slug,
      rowId: row.id,
      version: row.version,
      lineSlug: lineSlug ?? null,
      fields,
      canonical: canonicalPayload('knowledge_doc', { ...fields, lineSlug: lineSlug ?? null }),
    });
  }

  const ruleRows = await deps.db
    .select({ row: rules, lineSlug: businessLines.slug })
    .from(rules)
    .leftJoin(businessLines, eq(businessLines.id, rules.lineId))
    .where(and(eq(rules.tenantId, tenantId), eq(rules.status, 'published')));
  for (const { row, lineSlug } of ruleRows) {
    const fields: Record<string, unknown> = {
      title: row.title,
      instruction: row.instruction,
      params: row.params,
      kind: row.kind,
    };
    out.push({
      entityType: 'rule',
      slug: row.slug,
      rowId: row.id,
      version: row.version,
      lineSlug: lineSlug ?? null,
      fields,
      canonical: canonicalPayload('rule', { ...fields, lineSlug: lineSlug ?? null }),
    });
  }

  return out;
}

/**
 * Digest sha256 do conteúdo staged: slugs + canónicos, ordenados por tipo e
 * slug. É a chave de idempotência da publicação (não inclui `baseVersion`,
 * para que um retry com o mesmo conteúdo caia na mesma publicação).
 */
export function digestDraft(staged: readonly StagedItemRow[]): string {
  const ordered = [...staged].sort(
    (a, b) => a.entityType.localeCompare(b.entityType) || a.slug.localeCompare(b.slug),
  );
  const material = ordered
    .map((item) =>
      [item.entityType, item.slug, item.op, stagedCanonical(item)].join('\u0000'),
    )
    .join('\n');
  return createHash('sha256').update(material).digest('hex');
}

async function loadDiff(deps: TrainDeps): Promise<{
  staged: StagedItemRow[];
  published: PublishedEntity[];
  diff: ReturnType<typeof computeDraftDiff>;
  digest: string;
}> {
  const staged = await listDraftItems(deps);
  const published = await loadPublished(deps);
  const snapshots = published.map((item) => ({
    slug: item.slug,
    entityType: item.entityType,
    version: item.version,
    canonical: item.canonical,
    rowId: item.rowId,
  }));
  return {
    staged,
    published,
    diff: computeDraftDiff(staged, snapshots),
    digest: digestDraft(staged),
  };
}

async function findPublication(deps: TrainDeps, digest: string) {
  const [row] = await deps.db
    .select()
    .from(knowledgePublications)
    .where(
      and(
        eq(knowledgePublications.tenantId, deps.scope.tenantId),
        eq(knowledgePublications.idempotencyKey, digest),
      ),
    )
    .limit(1);
  return row;
}

/** Última publicação de treino do tenant (retry depois de o staging ser limpo). */
async function findLatestTrainPublication(deps: TrainDeps) {
  const [row] = await deps.db
    .select()
    .from(knowledgePublications)
    .where(
      and(
        eq(knowledgePublications.tenantId, deps.scope.tenantId),
        eq(knowledgePublications.kind, 'train'),
      ),
    )
    .orderBy(desc(knowledgePublications.createdAt), desc(knowledgePublications.id))
    .limit(1);
  return row;
}

function appliedCounts(value: unknown): AppliedCounts {
  const rec = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const count = (raw: unknown): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return { added: count(rec.added), updated: count(rec.updated), archived: count(rec.archived) };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown): unknown =>
    typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return code(error) === '23505' || code((error as { cause?: unknown } | null)?.cause) === '23505';
}

/** Revisão do estado prévio, na versão actual, antes do bump. */
async function writeRevision(
  tx: TxClient,
  input: {
    tenantId: string;
    entityType: DraftEntityType;
    entityId: string;
    version: number;
    snapshot: Record<string, unknown>;
    changedById: string;
    publicationId: string;
  },
): Promise<void> {
  await tx.insert(knowledgeRevisions).values({
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    version: input.version,
    snapshot: input.snapshot,
    changedById: input.changedById,
    publicationId: input.publicationId,
  });
}

/**
 * Materializa os chunks do rascunho em `knowledge_chunks` (mesma transacção).
 * Update substitui: apaga os chunks da entidade antes de inserir os novos.
 */
async function replaceChunks(
  tx: TxClient,
  input: {
    tenantId: string;
    entityType: 'knowledge_doc' | 'catalog_item';
    entityId: string;
    chunks: readonly StagedChunk[];
    embeddingModel: string | null;
  },
): Promise<void> {
  if (input.entityType === 'knowledge_doc') {
    await tx
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenantId, input.tenantId),
          eq(knowledgeChunks.docId, input.entityId),
        ),
      );
  } else {
    await tx
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenantId, input.tenantId),
          eq(knowledgeChunks.catalogItemId, input.entityId),
        ),
      );
  }

  if (input.chunks.length === 0) return;
  const source: 'doc' | 'catalog' = input.entityType === 'knowledge_doc' ? 'doc' : 'catalog';
  await tx.insert(knowledgeChunks).values(
    input.chunks.map((chunk) => ({
      tenantId: input.tenantId,
      source,
      docId: input.entityType === 'knowledge_doc' ? input.entityId : null,
      catalogItemId: input.entityType === 'catalog_item' ? input.entityId : null,
      position: chunk.position,
      content: chunk.content,
      embedding: chunk.embedding,
      embeddingModel: input.embeddingModel,
      active: true,
    })),
  );
}

/** Arquivar um doc/catálogo tira os chunks da pesquisa sem apagar o histórico. */
async function deactivateChunks(
  tx: TxClient,
  input: { tenantId: string; entityType: 'knowledge_doc' | 'catalog_item'; entityId: string },
): Promise<void> {
  if (input.entityType === 'knowledge_doc') {
    await tx
      .update(knowledgeChunks)
      .set({ active: false })
      .where(
        and(
          eq(knowledgeChunks.tenantId, input.tenantId),
          eq(knowledgeChunks.docId, input.entityId),
        ),
      );
  } else {
    await tx
      .update(knowledgeChunks)
      .set({ active: false })
      .where(
        and(
          eq(knowledgeChunks.tenantId, input.tenantId),
          eq(knowledgeChunks.catalogItemId, input.entityId),
        ),
      );
  }
}

/** Aplica uma entrada do plano dentro da transacção. */
async function applyWrite(
  tx: TxClient,
  write: PlannedWrite,
  ctx: {
    tenantId: string;
    changedById: string;
    publicationId: string;
    lineId: string | null;
    embeddingModel: string | null;
    now: Date;
  },
): Promise<void> {
  const { tenantId, changedById, publicationId, lineId, embeddingModel, now } = ctx;

  if (write.action === 'archive') {
    await writeRevision(tx, {
      tenantId,
      entityType: write.entry.entityType,
      entityId: write.published.rowId,
      version: write.published.version,
      snapshot: { ...write.published.fields, lineSlug: write.published.lineSlug },
      changedById,
      publicationId,
    });
    const archived = await (write.entry.entityType === 'catalog_item'
      ? tx
          .update(catalogItems)
          .set({ status: 'archived', version: write.published.version + 1, updatedAt: now })
          .where(and(eq(catalogItems.id, write.published.rowId), eq(catalogItems.tenantId, tenantId)))
          .returning({ id: catalogItems.id })
      : write.entry.entityType === 'knowledge_doc'
        ? tx
            .update(knowledgeDocs)
            .set({ status: 'archived', version: write.published.version + 1, updatedAt: now })
            .where(and(eq(knowledgeDocs.id, write.published.rowId), eq(knowledgeDocs.tenantId, tenantId)))
            .returning({ id: knowledgeDocs.id })
        : tx
            .update(rules)
            .set({ status: 'archived', version: write.published.version + 1, updatedAt: now })
            .where(and(eq(rules.id, write.published.rowId), eq(rules.tenantId, tenantId)))
            .returning({ id: rules.id }));
    if (archived.length === 0) {
      throw new HttpError(409, 'draft_conflicts', `item mudou durante a validação: ${write.entry.slug}`, undefined, {
        entries: [write.entry],
      });
    }
    if (write.entry.entityType !== 'rule') {
      await deactivateChunks(tx, {
        tenantId,
        entityType: write.entry.entityType,
        entityId: write.published.rowId,
      });
    }
    return;
  }

  if (write.action === 'insert') {
    switch (write.values.entityType) {
      case 'catalog_item': {
        const values = write.values.catalog;
        if (lineId === null) {
          throw new TrainServiceError('line_required', 422, 'catálogo exige linha de negócio confirmada');
        }
        const [row] = await tx
          .insert(catalogItems)
          .values({
            tenantId,
            lineId,
            kind: values.kind,
            name: values.name,
            slug: write.entry.slug,
            summary: values.summary,
            details: values.details,
            pricingMode: values.pricingMode,
            priceAmount: values.priceAmount,
            currency: values.currency,
            priceNote: values.priceNote,
            availability: values.availability,
            status: 'published',
            ownerId: changedById,
            version: 1,
          })
          .returning({ id: catalogItems.id });
        if (row === undefined) throw new Error('publicação: insert de catálogo sem returning');
        await writeRevision(tx, {
          tenantId,
          entityType: 'catalog_item',
          entityId: row.id,
          version: 1,
          snapshot: snapshotOf(write.values, write.staged.lineSlug),
          changedById,
          publicationId,
        });
        await replaceChunks(tx, {
          tenantId,
          entityType: 'catalog_item',
          entityId: row.id,
          chunks: write.chunks,
          embeddingModel,
        });
        return;
      }
      case 'knowledge_doc': {
        const values = write.values.doc;
        const [row] = await tx
          .insert(knowledgeDocs)
          .values({
            tenantId,
            lineId,
            type: values.type,
            title: values.title,
            slug: write.entry.slug,
            body: values.body,
            status: 'published',
            ownerId: changedById,
            version: 1,
          })
          .returning({ id: knowledgeDocs.id });
        if (row === undefined) throw new Error('publicação: insert de documento sem returning');
        await writeRevision(tx, {
          tenantId,
          entityType: 'knowledge_doc',
          entityId: row.id,
          version: 1,
          snapshot: snapshotOf(write.values, write.staged.lineSlug),
          changedById,
          publicationId,
        });
        await replaceChunks(tx, {
          tenantId,
          entityType: 'knowledge_doc',
          entityId: row.id,
          chunks: write.chunks,
          embeddingModel,
        });
        return;
      }
      case 'rule': {
        const values = write.values.rule;
        const [row] = await tx
          .insert(rules)
          .values({
            tenantId,
            lineId,
            kind: values.kind,
            title: values.title,
            slug: write.entry.slug,
            instruction: values.instruction,
            params: values.params,
            status: 'published',
            ownerId: changedById,
            version: 1,
          })
          .returning({ id: rules.id });
        if (row === undefined) throw new Error('publicação: insert de regra sem returning');
        await writeRevision(tx, {
          tenantId,
          entityType: 'rule',
          entityId: row.id,
          version: 1,
          snapshot: snapshotOf(write.values, write.staged.lineSlug),
          changedById,
          publicationId,
        });
        return;
      }
    }
  }

  // update (inclui conflitos aceites que prevalecem sobre o activo)
  const { published } = write;
  await writeRevision(tx, {
    tenantId,
    entityType: write.entry.entityType,
    entityId: published.rowId,
    version: published.version,
    snapshot: { ...published.fields, lineSlug: published.lineSlug },
    changedById,
    publicationId,
  });
  const nextVersion = published.version + 1;

  switch (write.values.entityType) {
    case 'catalog_item': {
      const values = write.values.catalog;
      if (lineId === null) {
        throw new TrainServiceError('line_required', 422, 'catálogo exige linha de negócio confirmada');
      }
      const updated = await tx
        .update(catalogItems)
        .set({
          lineId,
          name: values.name,
          summary: values.summary,
          details: values.details,
          pricingMode: values.pricingMode,
          priceAmount: values.priceAmount,
          currency: values.currency,
          priceNote: values.priceNote,
          availability: values.availability,
          version: nextVersion,
          updatedAt: now,
        })
        .where(and(eq(catalogItems.id, published.rowId), eq(catalogItems.tenantId, tenantId)))
        .returning({ id: catalogItems.id });
      if (updated.length === 0) {
        throw new HttpError(409, 'draft_conflicts', `item mudou durante a validação: ${write.entry.slug}`, undefined, {
          entries: [write.entry],
        });
      }
      await replaceChunks(tx, {
        tenantId,
        entityType: 'catalog_item',
        entityId: published.rowId,
        chunks: write.chunks,
        embeddingModel,
      });
      return;
    }
    case 'knowledge_doc': {
      const values = write.values.doc;
      const updated = await tx
        .update(knowledgeDocs)
        .set({
          lineId,
          type: values.type,
          title: values.title,
          body: values.body,
          version: nextVersion,
          updatedAt: now,
        })
        .where(and(eq(knowledgeDocs.id, published.rowId), eq(knowledgeDocs.tenantId, tenantId)))
        .returning({ id: knowledgeDocs.id });
      if (updated.length === 0) {
        throw new HttpError(409, 'draft_conflicts', `item mudou durante a validação: ${write.entry.slug}`, undefined, {
          entries: [write.entry],
        });
      }
      await replaceChunks(tx, {
        tenantId,
        entityType: 'knowledge_doc',
        entityId: published.rowId,
        chunks: write.chunks,
        embeddingModel,
      });
      return;
    }
    case 'rule': {
      const values = write.values.rule;
      const updated = await tx
        .update(rules)
        .set({
          lineId,
          title: values.title,
          instruction: values.instruction,
          params: values.params,
          version: nextVersion,
          updatedAt: now,
        })
        .where(and(eq(rules.id, published.rowId), eq(rules.tenantId, tenantId)))
        .returning({ id: rules.id });
      if (updated.length === 0) {
        throw new HttpError(409, 'draft_conflicts', `item mudou durante a validação: ${write.entry.slug}`, undefined, {
          entries: [write.entry],
        });
      }
      return;
    }
  }
}

/** Diff actual do rascunho + digest (GET /train/diff). */
export async function diffDraft(deps: TrainDeps): Promise<DiffDraftResult> {
  const { diff, digest } = await loadDiff(deps);
  return { entries: diff.entries, unconfirmedSlugs: diff.unconfirmedSlugs, digest };
}

/**
 * Valida e publica o rascunho numa transacção. Erros de bloqueio são
 * `HttpError` (422/409) com a lista no problem+json; a repetição do mesmo
 * conteúdo devolve a publicação existente.
 */
export async function validateDraft(
  deps: TrainDeps,
  input: ValidateDraftInput,
): Promise<ValidateDraftResult> {
  const { staged, published, diff, digest } = await loadDiff(deps);

  // Retry em corrida depois de a primeira validação já ter limpado o staging:
  // não há conteúdo novo para aplicar. Devolve a última publicação de treino
  // em vez de criar uma publicação vazia (mantém "exactamente uma").
  if (staged.length === 0) {
    const latest = await findLatestTrainPublication(deps);
    if (latest !== undefined) {
      return {
        publicationId: latest.id,
        applied: appliedCounts(latest.applied),
        idempotent: true,
      };
    }
  }

  // Idempotência ANTES dos conflitos: um retry do mesmo conteúdo pode já ver
  // o activo alterado pela primeira validação (senão devolveria 409).
  const existing = await findPublication(deps, digest);
  if (existing !== undefined) {
    return {
      publicationId: existing.id,
      applied: appliedCounts(existing.applied),
      idempotent: true,
    };
  }

  if (diff.unconfirmedSlugs.length > 0) {
    throw new HttpError(
      422,
      'lines_unconfirmed',
      `linhas por confirmar: ${diff.unconfirmedSlugs.join(', ')}`,
      undefined,
      { unconfirmedSlugs: diff.unconfirmedSlugs },
    );
  }

  const accepted = new Set(input.acceptConflicts ?? []);
  const blocking = diff.entries.filter(
    (entry) => entry.classification === 'conflict' && !accepted.has(entry.slug),
  );
  if (blocking.length > 0) {
    throw new HttpError(
      409,
      'draft_conflicts',
      `conflitos por resolver: ${blocking.map((e) => e.slug).join(', ')}`,
      undefined,
      { entries: blocking },
    );
  }

  const stagedByKey = new Map(staged.map((row) => [keyOf(row.entityType, row.slug), row]));
  const publishedByKey = new Map(
    published.map((item) => [keyOf(item.entityType, item.slug), item]),
  );

  const plan: PlannedWrite[] = [];
  for (const entry of diff.entries) {
    if (entry.classification === 'unchanged') continue;
    const stagedRow = stagedByKey.get(keyOf(entry.entityType, entry.slug));
    if (stagedRow === undefined) throw new Error(`diff sem staged correspondente: ${entry.slug}`);
    const current = publishedByKey.get(keyOf(entry.entityType, entry.slug));

    if (entry.classification === 'added') {
      plan.push({
        action: 'insert',
        entry,
        staged: stagedRow,
        values: parseStagedValues(entry.entityType, stagedRow.payload),
        chunks: parseStagedChunks(stagedRow.chunks),
      });
    } else if (entry.classification === 'updated') {
      if (current === undefined) throw new Error(`update sem activo: ${entry.slug}`);
      plan.push({
        action: 'update',
        entry,
        staged: stagedRow,
        published: current,
        values: parseStagedValues(entry.entityType, stagedRow.payload),
        chunks: parseStagedChunks(stagedRow.chunks),
      });
    } else if (entry.classification === 'archived') {
      if (current === undefined) throw new Error(`archive sem activo: ${entry.slug}`);
      plan.push({ action: 'archive', entry, staged: stagedRow, published: current });
    } else if (entry.op === 'delete') {
      // Conflito de delete aceite: só arquiva se houver activo.
      if (current !== undefined) plan.push({ action: 'archive', entry, staged: stagedRow, published: current });
    } else if (current === undefined) {
      // Conflito de update sobre item entretanto inexistente: o rascunho entra.
      plan.push({
        action: 'insert',
        entry,
        staged: stagedRow,
        values: parseStagedValues(entry.entityType, stagedRow.payload),
        chunks: parseStagedChunks(stagedRow.chunks),
      });
    } else {
      // Conflito de create/update aceite: o rascunho prevalece sobre o activo.
      plan.push({
        action: 'update',
        entry,
        staged: stagedRow,
        published: current,
        values: parseStagedValues(entry.entityType, stagedRow.payload),
        chunks: parseStagedChunks(stagedRow.chunks),
      });
    }
  }

  const applied: AppliedCounts = {
    added: plan.filter((write) => write.action === 'insert').length,
    updated: plan.filter((write) => write.action === 'update').length,
    archived: plan.filter((write) => write.action === 'archive').length,
  };

  // Resolve os `lineId` antes da transacção (dicionário global; 404 se faltar).
  const lineIdBySlug = new Map<string, string>();
  const lineIds: Array<string | null> = [];
  for (const write of plan) {
    if (write.action === 'archive') {
      lineIds.push(null);
      continue;
    }
    const slug = write.staged.lineSlug;
    if (slug === null) {
      if (write.entry.entityType === 'catalog_item') {
        throw new TrainServiceError('line_required', 422, 'catálogo exige linha de negócio confirmada');
      }
      lineIds.push(null);
      continue;
    }
    const cached = lineIdBySlug.get(slug);
    if (cached !== undefined) {
      lineIds.push(cached);
      continue;
    }
    const id = await resolveLineId(deps.db, slug);
    lineIdBySlug.set(slug, id);
    lineIds.push(id);
  }

  const now = deps.now();
  let publicationId: string;
  try {
    publicationId = await deps.db.transaction(async (tx) => {
      const [publication] = await tx
        .insert(knowledgePublications)
        .values({
          tenantId: deps.scope.tenantId,
          kind: 'train',
          idempotencyKey: digest,
          createdById: input.changedById,
          applied,
        })
        .returning({ id: knowledgePublications.id });
      if (publication === undefined) throw new Error('publicação sem returning');

      for (const [index, write] of plan.entries()) {
        await applyWrite(tx, write, {
          tenantId: deps.scope.tenantId,
          changedById: input.changedById,
          publicationId: publication.id,
          lineId: lineIds[index] ?? null,
          embeddingModel: deps.embedder?.model ?? null,
          now,
        });
      }

      // Staging limpo na MESMA transacção (inclui unchanged e conflitos aceites).
      await tx
        .delete(knowledgeDraftItems)
        .where(eq(knowledgeDraftItems.tenantId, deps.scope.tenantId));

      return publication.id;
    });
  } catch (error) {
    // Corrida entre duas validações idênticas: o unique (tenant, digest) é a
    // rede; relê a publicação vencedora e devolve idempotente.
    if (isUniqueViolation(error)) {
      const raced = await findPublication(deps, digest);
      if (raced !== undefined) {
        return {
          publicationId: raced.id,
          applied: appliedCounts(raced.applied),
          idempotent: true,
        };
      }
    }
    throw error;
  }

  await deps.audit.record({
    tenantId: deps.scope.tenantId,
    actorId: input.changedById,
    action: 'knowledge.validated',
    entity: 'knowledge_publication',
    entityId: publicationId,
    detail: { ...applied },
    at: deps.now(),
  });

  return { publicationId, applied, idempotent: false };
}
