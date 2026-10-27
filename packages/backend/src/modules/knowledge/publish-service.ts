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

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DbClient } from '../../adapters/db/index.js';
import { HttpError } from '../../adapters/http/errors.js';
import type { DiffEntry } from './diff.js';
import { asEntityType, canonicalPayload, computeDraftDiff, stagedCanonical } from './diff.js';
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

/**
 * Revisão do estado da entidade na versão indicada.
 *
 * A criação grava uma revisão na versão 0 com `snapshot: { absent: true }`
 * (o estado anterior é a inexistência) e a entidade nasce na versão 1. Assim
 * a primeira actualização, que regista o pré-estado na versão 1, nunca colide
 * com a revisão da criação no unique (entityType, entityId, version).
 *
 * `note` diz explicitamente o que a publicação fez (`create`/`update`/
 * `archive`), porque a reversão precisa de distinguir "criado por esta
 * publicação" de "actualizado por esta".
 *
 * `ignoreVersionConflict` é uma rede defensiva da T7 para dados anteriores a
 * esta semântica (revisões `create` gravadas na versão 1).
 */
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
    note: 'create' | 'update' | 'archive' | 'quick_edit' | 'revert';
    ignoreVersionConflict?: boolean;
  },
): Promise<void> {
  const values = {
    tenantId: input.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    version: input.version,
    snapshot: input.snapshot,
    changedById: input.changedById,
    publicationId: input.publicationId,
    note: input.note,
  };
  if (input.ignoreVersionConflict === true) {
    await tx.insert(knowledgeRevisions).values(values).onConflictDoNothing();
    return;
  }
  await tx.insert(knowledgeRevisions).values(values);
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

/** Estado anterior à criação: a entidade não existia. */
const ABSENT_SNAPSHOT = { absent: true } as const;

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
      note: 'archive',
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
          version: 0,
          snapshot: ABSENT_SNAPSHOT,
          changedById,
          publicationId,
          note: 'create',
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
          version: 0,
          snapshot: ABSENT_SNAPSHOT,
          changedById,
          publicationId,
          note: 'create',
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
          version: 0,
          snapshot: ABSENT_SNAPSHOT,
          changedById,
          publicationId,
          note: 'create',
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
    note: 'update',
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

// ───────────── Task 7: edição rápida (dia-a-dia) e reversão ─────────────
//
// A edição rápida muda UM item activo (preço, texto, regra) sem passar pelo
// rascunho: revisão do estado actual + update com bump de versão + publicação
// `quick_edit`, tudo na mesma transacção. A reversão desfaz uma publicação
// inteira (tudo ou nada) desde que nenhuma das entidades tenha mudado depois;
// caso contrário 409 `stale_revert` com os slugs.

/** Slugs válidos de linha de negócio (dicionário global). */
const LINE_SLUGS = z.enum(['software', 'custom', 'telecom', 'cctv']);

/** Preço aceite num patch: número finito ou string numérica (numeric(14,2)). */
const pricePatchSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(\.\d{1,2})?$/),
]);

// Patch PARCIAL por tipo: só os campos editáveis do dia-a-dia (o `kind`, o
// `slug` e a identidade nunca mudam por aqui).
const catalogPatchSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    pricingMode: z.enum(['fixed', 'from', 'quote_only']),
    priceAmount: pricePatchSchema.nullable(),
    currency: z.string().min(1),
    priceNote: z.string().nullable(),
    availability: z.enum(['available', 'limited', 'unavailable']),
    lineSlug: LINE_SLUGS.nullable(),
  })
  .partial()
  .strict();

const docPatchSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    type: z.enum(DOC_TYPES),
    // Doc pode ser global (null); catálogo e regra exigem linha.
    lineSlug: LINE_SLUGS.nullable(),
  })
  .partial()
  .strict();

const rulePatchSchema = z
  .object({
    title: z.string().min(1),
    instruction: z.string(),
    params: z.record(z.string(), z.unknown()).nullable(),
    lineSlug: LINE_SLUGS.nullable(),
  })
  .partial()
  .strict();

const quickPatchSchemas = {
  catalog_item: catalogPatchSchema,
  knowledge_doc: docPatchSchema,
  rule: rulePatchSchema,
} as const;

function invalidPatch(detail: string): HttpError {
  return new HttpError(400, 'invalid_patch', detail);
}

/** Valida o patch do tipo (zod) e recusa um patch vazio. */
function parseQuickPatch<T>(schema: z.ZodType<T>, patch: Record<string, unknown>): T {
  const parsed = schema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidPatch(`${issue?.path.join('.') || '(raiz)'}: ${issue?.message ?? 'valor inválido'}`);
  }
  if (Object.keys(parsed.data as object).length === 0) throw invalidPatch('patch vazio');
  return parsed.data;
}

// Regra da extracção (T3) espelhada na edição: `fixed`/`from` exigem um preço
// numérico; `quote_only` exige null. Nunca se inventa preço.
function priceCoherent(
  pricingMode: 'fixed' | 'from' | 'quote_only',
  priceAmount: string | null,
): boolean {
  if (pricingMode === 'quote_only') return priceAmount === null;
  return priceAmount !== null && /^\d+(\.\d{1,2})?$/.test(priceAmount);
}

function assertPriceCoherence(
  pricingMode: 'fixed' | 'from' | 'quote_only',
  priceAmount: string | null,
): void {
  if (priceCoherent(pricingMode, priceAmount)) return;
  if (pricingMode === 'quote_only') {
    throw invalidPatch("pricingMode 'quote_only' exige priceAmount null");
  }
  throw invalidPatch(`pricingMode '${pricingMode}' exige priceAmount numérico`);
}

function normalizePriceInput(value: string | number | null): string | null {
  if (value === null) return null;
  return typeof value === 'number' ? String(value) : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Linha por id → slug (só para montar o snapshot). */
async function lineSlugById(tx: TxClient, lineId: string | null): Promise<string | null> {
  if (lineId === null) return null;
  const [row] = await tx
    .select({ slug: businessLines.slug })
    .from(businessLines)
    .where(eq(businessLines.id, lineId))
    .limit(1);
  return row?.slug ?? null;
}

/** Slug de linha → id; linha desconhecida é 404 `line_not_found` (como na T5). */
async function lookupLineId(tx: TxClient, slug: string): Promise<string> {
  const [row] = await tx
    .select({ id: businessLines.id })
    .from(businessLines)
    .where(eq(businessLines.slug, slug))
    .limit(1);
  if (row === undefined) {
    throw new TrainServiceError('line_not_found', 404, `linha de negócio inexistente: ${slug}`);
  }
  return row.id;
}

/** Linha obrigatória (catálogo e regra): null é 422 `line_required`. */
async function resolveRequiredLine(tx: TxClient, slug: string | null): Promise<string> {
  if (slug === null) {
    throw new TrainServiceError('line_required', 422, 'linha de negócio obrigatória');
  }
  return lookupLineId(tx, slug);
}

/** Linha opcional (documento e restauro de estado): null vale. */
async function resolveOptionalLine(tx: TxClient, slug: string | null): Promise<string | null> {
  return slug === null ? null : lookupLineId(tx, slug);
}

/** Item activo (ou arquivado) carregado dentro da transacção, com lock de linha. */
type LoadedEntity =
  | {
      entityType: 'catalog_item';
      row: typeof catalogItems.$inferSelect;
      lineSlug: string | null;
      snapshot: Record<string, unknown>;
    }
  | {
      entityType: 'knowledge_doc';
      row: typeof knowledgeDocs.$inferSelect;
      lineSlug: string | null;
      snapshot: Record<string, unknown>;
    }
  | {
      entityType: 'rule';
      row: typeof rules.$inferSelect;
      lineSlug: string | null;
      snapshot: Record<string, unknown>;
    };

function catalogSnapshot(
  row: typeof catalogItems.$inferSelect,
  lineSlug: string | null,
): Record<string, unknown> {
  return {
    name: row.name,
    summary: row.summary,
    details: row.details,
    pricingMode: row.pricingMode,
    priceAmount: row.priceAmount,
    currency: row.currency,
    priceNote: row.priceNote,
    availability: row.availability,
    lineSlug,
  };
}

function docSnapshot(
  row: typeof knowledgeDocs.$inferSelect,
  lineSlug: string | null,
): Record<string, unknown> {
  return { title: row.title, body: row.body, type: row.type, lineSlug };
}

function ruleSnapshot(
  row: typeof rules.$inferSelect,
  lineSlug: string | null,
): Record<string, unknown> {
  return { title: row.title, instruction: row.instruction, params: row.params, lineSlug };
}

/**
 * Carrega a entidade sob o scope com `FOR UPDATE` (sem join: o Postgres não
 * permite FOR UPDATE no lado nullable de um outer join). Devolve null se não
 * existir no tenant.
 */
async function loadEntityForUpdate(
  tx: TxClient,
  tenantId: string,
  entityType: DraftEntityType,
  entityId: string,
): Promise<LoadedEntity | null> {
  switch (entityType) {
    case 'catalog_item': {
      const [row] = await tx
        .select()
        .from(catalogItems)
        .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.id, entityId)))
        .for('update')
        .limit(1);
      if (row === undefined) return null;
      const lineSlug = await lineSlugById(tx, row.lineId);
      return { entityType, row, lineSlug, snapshot: catalogSnapshot(row, lineSlug) };
    }
    case 'knowledge_doc': {
      const [row] = await tx
        .select()
        .from(knowledgeDocs)
        .where(and(eq(knowledgeDocs.tenantId, tenantId), eq(knowledgeDocs.id, entityId)))
        .for('update')
        .limit(1);
      if (row === undefined) return null;
      const lineSlug = await lineSlugById(tx, row.lineId);
      return { entityType, row, lineSlug, snapshot: docSnapshot(row, lineSlug) };
    }
    case 'rule': {
      const [row] = await tx
        .select()
        .from(rules)
        .where(and(eq(rules.tenantId, tenantId), eq(rules.id, entityId)))
        .for('update')
        .limit(1);
      if (row === undefined) return null;
      const lineSlug = await lineSlugById(tx, row.lineId);
      return { entityType, row, lineSlug, snapshot: ruleSnapshot(row, lineSlug) };
    }
  }
}

export interface QuickEditInput {
  itemId: string;
  entityType: DraftEntityType;
  patch: Record<string, unknown>;
  changedById: string;
}

/** Aplica o patch validado ao item (o bump/`updatedAt` é comum aos três tipos). */
async function applyQuickPatch(
  tx: TxClient,
  current: LoadedEntity,
  patch: Record<string, unknown>,
  ctx: { tenantId: string; now: Date },
): Promise<void> {
  const { tenantId, now } = ctx;

  switch (current.entityType) {
    case 'catalog_item': {
      const value = parseQuickPatch(quickPatchSchemas.catalog_item, patch);
      const pricingMode = value.pricingMode ?? current.row.pricingMode;
      const priceAmount =
        value.priceAmount !== undefined
          ? normalizePriceInput(value.priceAmount)
          : current.row.priceAmount;
      assertPriceCoherence(pricingMode, priceAmount);
      const lineId =
        value.lineSlug !== undefined
          ? await resolveRequiredLine(tx, value.lineSlug)
          : current.row.lineId;

      await tx
        .update(catalogItems)
        .set({
          ...(value.name !== undefined ? { name: value.name } : {}),
          ...(value.summary !== undefined ? { summary: value.summary } : {}),
          ...(value.details !== undefined ? { details: value.details } : {}),
          ...(value.pricingMode !== undefined ? { pricingMode: value.pricingMode } : {}),
          ...(value.priceAmount !== undefined ? { priceAmount } : {}),
          ...(value.currency !== undefined ? { currency: value.currency } : {}),
          ...(value.priceNote !== undefined ? { priceNote: value.priceNote } : {}),
          ...(value.availability !== undefined ? { availability: value.availability } : {}),
          lineId,
          version: current.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(catalogItems.id, current.row.id), eq(catalogItems.tenantId, tenantId)));
      return;
    }
    case 'knowledge_doc': {
      const value = parseQuickPatch(quickPatchSchemas.knowledge_doc, patch);
      const lineId =
        value.lineSlug !== undefined
          ? await resolveOptionalLine(tx, value.lineSlug)
          : current.row.lineId;

      await tx
        .update(knowledgeDocs)
        .set({
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.body !== undefined ? { body: value.body } : {}),
          ...(value.type !== undefined ? { type: value.type } : {}),
          lineId,
          version: current.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(knowledgeDocs.id, current.row.id), eq(knowledgeDocs.tenantId, tenantId)));
      return;
    }
    case 'rule': {
      const value = parseQuickPatch(quickPatchSchemas.rule, patch);
      const lineId =
        value.lineSlug !== undefined
          ? await resolveRequiredLine(tx, value.lineSlug)
          : current.row.lineId;

      await tx
        .update(rules)
        .set({
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.instruction !== undefined ? { instruction: value.instruction } : {}),
          ...(value.params !== undefined ? { params: value.params } : {}),
          lineId,
          version: current.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(rules.id, current.row.id), eq(rules.tenantId, tenantId)));
      return;
    }
  }
}

/** Registo de uma escrita de uma publicação (base da reversão). */
interface PublicationChange {
  entityType: DraftEntityType;
  entityId: string;
  slug: string;
  action: 'create' | 'update' | 'archive';
  /** Versão antes da publicação; null quando a entidade foi criada. */
  preVersion: number | null;
  /** Versão imediatamente depois da publicação. */
  postVersion: number;
}

const publicationChangeSchema = z.object({
  entityType: z.enum(['catalog_item', 'knowledge_doc', 'rule']),
  entityId: z.uuid(),
  slug: z.string(),
  action: z.enum(['create', 'update', 'archive']),
  preVersion: z.number().int().nullable(),
  postVersion: z.number().int(),
});

/** Lista de alterações gravada em `applied` (publicações novas); null se antiga. */
function changesFromApplied(applied: unknown): PublicationChange[] | null {
  if (typeof applied !== 'object' || applied === null) return null;
  const raw = (applied as Record<string, unknown>).changes;
  if (raw === undefined) return null;
  const parsed = z.array(publicationChangeSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Edita um item publicado. O patch é parcial e validado por tipo; preço e
 * `quote_only` seguem a regra da extracção. Tudo numa transacção: publicação
 * `quick_edit` + revisão do estado actual + update com bump de versão.
 *
 * Os `knowledge_chunks` NÃO são regenerados aqui: a busca semântica está
 * inactiva por desenho até ao ADR dos embeddings e os chunks voltam a ser
 * materializados na próxima publicação que corra com embedder. Limitação
 * aceite no fix round 1 (ruling 2).
 */
export async function quickEditItem(
  deps: TrainDeps,
  input: QuickEditInput,
): Promise<{ publicationId: string }> {
  const now = deps.now();

  const publicationId = await deps.db.transaction(async (tx) => {
    const current = await loadEntityForUpdate(
      tx,
      deps.scope.tenantId,
      input.entityType,
      input.itemId,
    );
    if (current === null || current.row.status !== 'published') {
      throw new HttpError(404, 'item_not_found', 'item publicado inexistente');
    }

    const change: PublicationChange = {
      entityType: current.entityType,
      entityId: current.row.id,
      slug: current.row.slug,
      action: 'update',
      preVersion: current.row.version,
      postVersion: current.row.version + 1,
    };

    const [publication] = await tx
      .insert(knowledgePublications)
      .values({
        tenantId: deps.scope.tenantId,
        kind: 'quick_edit',
        idempotencyKey: randomUUID(),
        createdById: input.changedById,
        applied: { added: 0, updated: 1, archived: 0, changes: [change] },
      })
      .returning({ id: knowledgePublications.id });
    if (publication === undefined) throw new Error('quick_edit: publicação sem returning');

    // Revisão do estado ACTUAL (versão anterior ao bump). Pode já existir uma
    // revisão desse estado (a `create` da versão 1); nesse caso reaproveita-se
    // o snapshot e o vínculo fica em `applied.changes`.
    // Invariante: o item está bloqueado com FOR UPDATE nesta transacção
    // (`loadEntityForUpdate`), logo não há escrita concorrente na mesma versão
    // e o snapshot é idêntico ao já existente por construção — o pré-estado não
    // muda dentro do lock.
    await writeRevision(tx, {
      tenantId: deps.scope.tenantId,
      entityType: current.entityType,
      entityId: current.row.id,
      version: current.row.version,
      snapshot: current.snapshot,
      changedById: input.changedById,
      publicationId: publication.id,
      note: 'quick_edit',
      ignoreVersionConflict: true,
    });

    await applyQuickPatch(tx, current, input.patch, {
      tenantId: deps.scope.tenantId,
      now,
    });

    return publication.id;
  });

  await deps.audit.record({
    tenantId: deps.scope.tenantId,
    actorId: input.changedById,
    action: 'knowledge.item_edited',
    entity: input.entityType,
    entityId: input.itemId,
    detail: { publicationId },
    at: deps.now(),
  });

  return { publicationId };
}

/** Publicação resumida para a listagem (histórico do painel). */
export interface PublicationSummary {
  id: string;
  kind: string;
  createdAt: Date;
  createdById: string;
  applied: unknown;
}

/** Últimas publicações do tenant, da mais recente para a mais antiga. */
export async function listPublications(
  deps: TrainDeps,
  limit = 50,
): Promise<PublicationSummary[]> {
  return deps.db
    .select({
      id: knowledgePublications.id,
      kind: knowledgePublications.kind,
      createdAt: knowledgePublications.createdAt,
      createdById: knowledgePublications.createdById,
      applied: knowledgePublications.applied,
    })
    .from(knowledgePublications)
    .where(eq(knowledgePublications.tenantId, deps.scope.tenantId))
    .orderBy(desc(knowledgePublications.createdAt), desc(knowledgePublications.id))
    .limit(limit);
}

/** Item activo na listagem consolidada (`GET /v1/knowledge/published`). */
export interface PublishedItemSummary {
  id: string;
  entityType: DraftEntityType;
  slug: string;
  /** Nome do item de catálogo (null nos documentos e regras). */
  name: string | null;
  /** Título do documento/regra (null no catálogo). */
  title: string | null;
  version: number;
  updatedAt: Date;
}

/**
 * Itens activos dos três tipos, por tipo e slug. `limit` é o máximo de linhas
 * devolvidas (o painel pagina por `limit`, sem cursor nesta entrega).
 */
export async function listPublishedItems(
  deps: TrainDeps,
  limit = 50,
): Promise<PublishedItemSummary[]> {
  const tenantId = deps.scope.tenantId;

  const [catalogRows, docRows, ruleRows] = await Promise.all([
    deps.db
      .select({
        id: catalogItems.id,
        slug: catalogItems.slug,
        name: catalogItems.name,
        version: catalogItems.version,
        updatedAt: catalogItems.updatedAt,
      })
      .from(catalogItems)
      .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.status, 'published')))
      .orderBy(asc(catalogItems.slug))
      .limit(limit),
    deps.db
      .select({
        id: knowledgeDocs.id,
        slug: knowledgeDocs.slug,
        title: knowledgeDocs.title,
        version: knowledgeDocs.version,
        updatedAt: knowledgeDocs.updatedAt,
      })
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.tenantId, tenantId), eq(knowledgeDocs.status, 'published')))
      .orderBy(asc(knowledgeDocs.slug))
      .limit(limit),
    deps.db
      .select({
        id: rules.id,
        slug: rules.slug,
        title: rules.title,
        version: rules.version,
        updatedAt: rules.updatedAt,
      })
      .from(rules)
      .where(and(eq(rules.tenantId, tenantId), eq(rules.status, 'published')))
      .orderBy(asc(rules.slug))
      .limit(limit),
  ]);

  const items: PublishedItemSummary[] = [
    ...catalogRows.map((row) => ({
      id: row.id,
      entityType: 'catalog_item' as const,
      slug: row.slug,
      name: row.name,
      title: null,
      version: row.version,
      updatedAt: row.updatedAt,
    })),
    ...docRows.map((row) => ({
      id: row.id,
      entityType: 'knowledge_doc' as const,
      slug: row.slug,
      name: null,
      title: row.title,
      version: row.version,
      updatedAt: row.updatedAt,
    })),
    ...ruleRows.map((row) => ({
      id: row.id,
      entityType: 'rule' as const,
      slug: row.slug,
      name: null,
      title: row.title,
      version: row.version,
      updatedAt: row.updatedAt,
    })),
  ];

  items.sort(
    (a, b) => a.entityType.localeCompare(b.entityType) || a.slug.localeCompare(b.slug),
  );
  return items.slice(0, limit);
}

/** Revisões de uma publicação → alterações (publicações anteriores à T7). */
async function changesFromRevisions(
  tx: TxClient,
  tenantId: string,
  publicationId: string,
): Promise<PublicationChange[]> {
  const rows = await tx
    .select()
    .from(knowledgeRevisions)
    .where(
      and(
        eq(knowledgeRevisions.tenantId, tenantId),
        eq(knowledgeRevisions.publicationId, publicationId),
      ),
    );
  return rows.map((row) => {
    // Revisões antigas (antes da T7) não têm nota: assume-se update (restauro).
    const action =
      row.note === 'create' ? 'create' : row.note === 'archive' ? 'archive' : 'update';
    return {
      entityType: asEntityType(row.entityType),
      entityId: row.entityId,
      slug: '',
      action,
      // A criação regista a versão 0 (estado ausente): a entidade nasce na 1,
      // por isso a versão imediatamente posterior é sempre `row.version + 1`.
      preVersion: action === 'create' ? null : row.version,
      postVersion: row.version + 1,
    };
  });
}

/** Snapshot gravado na revisão da versão indicada (o estado antes do bump). */
async function snapshotAtVersion(
  tx: TxClient,
  tenantId: string,
  entityType: DraftEntityType,
  entityId: string,
  version: number | null,
): Promise<Record<string, unknown> | null> {
  if (version === null) return null;
  const [row] = await tx
    .select({ snapshot: knowledgeRevisions.snapshot })
    .from(knowledgeRevisions)
    .where(
      and(
        eq(knowledgeRevisions.tenantId, tenantId),
        eq(knowledgeRevisions.entityType, entityType),
        eq(knowledgeRevisions.entityId, entityId),
        eq(knowledgeRevisions.version, version),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  return isPlainRecord(row.snapshot) ? row.snapshot : null;
}

const catalogRestoreSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  pricingMode: z.enum(['fixed', 'from', 'quote_only']),
  priceAmount: z.union([z.string(), z.number()]).nullable().optional(),
  currency: z.string().min(1).optional(),
  priceNote: z.string().nullable().optional(),
  availability: z.enum(['available', 'limited', 'unavailable']).optional(),
  lineSlug: z.string().nullable().optional(),
});

const docRestoreSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  type: z.enum(DOC_TYPES).optional(),
  lineSlug: z.string().nullable().optional(),
});

const ruleRestoreSchema = z.object({
  title: z.string().min(1),
  instruction: z.string(),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
  lineSlug: z.string().nullable().optional(),
});

function snapshotInvalid(slug: string): HttpError {
  return new HttpError(409, 'revert_snapshot_invalid', `snapshot inválido: ${slug}`);
}

/** Restaura o estado do snapshot (campos editáveis + linha) e republica. */
async function restoreEntity(
  tx: TxClient,
  entity: LoadedEntity,
  snapshot: Record<string, unknown>,
  ctx: { tenantId: string; now: Date },
): Promise<void> {
  const { tenantId, now } = ctx;

  switch (entity.entityType) {
    case 'catalog_item': {
      const parsed = catalogRestoreSchema.safeParse(snapshot);
      if (!parsed.success) throw snapshotInvalid(entity.row.slug);
      const value = parsed.data;
      const lineId =
        value.lineSlug === undefined
          ? entity.row.lineId
          : await resolveRequiredLine(tx, value.lineSlug);
      const priceAmount =
        value.priceAmount === undefined
          ? entity.row.priceAmount
          : normalizePriceInput(value.priceAmount);
      if (!priceCoherent(value.pricingMode, priceAmount)) throw snapshotInvalid(entity.row.slug);
      await tx
        .update(catalogItems)
        .set({
          name: value.name,
          summary: value.summary,
          details: value.details === undefined ? entity.row.details : value.details,
          pricingMode: value.pricingMode,
          priceAmount,
          currency: value.currency ?? entity.row.currency,
          priceNote: value.priceNote === undefined ? entity.row.priceNote : value.priceNote,
          availability: value.availability ?? entity.row.availability,
          lineId,
          status: 'published',
          version: entity.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(catalogItems.id, entity.row.id), eq(catalogItems.tenantId, tenantId)));
      return;
    }
    case 'knowledge_doc': {
      const parsed = docRestoreSchema.safeParse(snapshot);
      if (!parsed.success) throw snapshotInvalid(entity.row.slug);
      const value = parsed.data;
      const lineId =
        value.lineSlug === undefined
          ? entity.row.lineId
          : await resolveOptionalLine(tx, value.lineSlug);
      await tx
        .update(knowledgeDocs)
        .set({
          title: value.title,
          body: value.body,
          type: value.type ?? entity.row.type,
          lineId,
          status: 'published',
          version: entity.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(knowledgeDocs.id, entity.row.id), eq(knowledgeDocs.tenantId, tenantId)));
      return;
    }
    case 'rule': {
      const parsed = ruleRestoreSchema.safeParse(snapshot);
      if (!parsed.success) throw snapshotInvalid(entity.row.slug);
      const value = parsed.data;
      const lineId =
        value.lineSlug === undefined
          ? entity.row.lineId
          : await resolveOptionalLine(tx, value.lineSlug);
      await tx
        .update(rules)
        .set({
          title: value.title,
          instruction: value.instruction,
          params: value.params === undefined ? entity.row.params : value.params,
          lineId,
          status: 'published',
          version: entity.row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(rules.id, entity.row.id), eq(rules.tenantId, tenantId)));
      return;
    }
  }
}

/** Reactiva os chunks de um item restaurado (a pesquisa volta a vê-lo). */
async function reactivateChunks(
  tx: TxClient,
  input: { tenantId: string; entityType: 'knowledge_doc' | 'catalog_item'; entityId: string },
): Promise<void> {
  if (input.entityType === 'knowledge_doc') {
    await tx
      .update(knowledgeChunks)
      .set({ active: true })
      .where(
        and(
          eq(knowledgeChunks.tenantId, input.tenantId),
          eq(knowledgeChunks.docId, input.entityId),
        ),
      );
    return;
  }
  await tx
    .update(knowledgeChunks)
    .set({ active: true })
    .where(
      and(
        eq(knowledgeChunks.tenantId, input.tenantId),
        eq(knowledgeChunks.catalogItemId, input.entityId),
      ),
    );
}

/** Arquivar por reversão de uma criação (chunks saem da pesquisa). */
async function archiveEntity(
  tx: TxClient,
  entity: LoadedEntity,
  ctx: { tenantId: string; now: Date },
): Promise<void> {
  switch (entity.entityType) {
    case 'catalog_item':
      await tx
        .update(catalogItems)
        .set({ status: 'archived', version: entity.row.version + 1, updatedAt: ctx.now })
        .where(
          and(eq(catalogItems.id, entity.row.id), eq(catalogItems.tenantId, ctx.tenantId)),
        );
      await deactivateChunks(tx, {
        tenantId: ctx.tenantId,
        entityType: 'catalog_item',
        entityId: entity.row.id,
      });
      return;
    case 'knowledge_doc':
      await tx
        .update(knowledgeDocs)
        .set({ status: 'archived', version: entity.row.version + 1, updatedAt: ctx.now })
        .where(
          and(eq(knowledgeDocs.id, entity.row.id), eq(knowledgeDocs.tenantId, ctx.tenantId)),
        );
      await deactivateChunks(tx, {
        tenantId: ctx.tenantId,
        entityType: 'knowledge_doc',
        entityId: entity.row.id,
      });
      return;
    case 'rule':
      await tx
        .update(rules)
        .set({ status: 'archived', version: entity.row.version + 1, updatedAt: ctx.now })
        .where(and(eq(rules.id, entity.row.id), eq(rules.tenantId, ctx.tenantId)));
      return;
  }
}

export interface RevertInput {
  /** Publicação a desfazer (`train` ou `quick_edit`). */
  publicationId: string;
  changedById: string;
}

type PlannedRevert =
  | { kind: 'archive'; entity: LoadedEntity }
  | { kind: 'restore'; entity: LoadedEntity; snapshot: Record<string, unknown> };

/**
 * Desfaz uma publicação inteira. Só avança se TODAS as entidades estiverem na
 * versão imediatamente posterior à publicação; qualquer escrita entretanto é
 * `409 stale_revert` (com os slugs) e nada muda. Criação → arquivar; update e
 * archive → repor o snapshot anterior com bump de versão. Tudo na transacção.
 */
export async function revertPublication(
  deps: TrainDeps,
  input: RevertInput,
): Promise<{ reverted: number }> {
  const now = deps.now();
  let reverted = 0;

  const publicationId = await deps.db.transaction(async (tx) => {
    const tenantId = deps.scope.tenantId;

    const [source] = await tx
      .select()
      .from(knowledgePublications)
      .where(
        and(
          eq(knowledgePublications.tenantId, tenantId),
          eq(knowledgePublications.id, input.publicationId),
        ),
      )
      .limit(1);
    if (source === undefined) {
      throw new HttpError(404, 'publication_not_found', 'publicação inexistente');
    }
    // Uma reversão de reversão exigiria repor o estado de um estado já
    // reposto; recusa-se para não haver duplo-desfazer ambíguo.
    if (source.kind === 'revert') {
      throw new HttpError(409, 'not_revertible', 'uma reversão não pode ser revertida');
    }

    // Publicações da T7 trazem a lista de alterações; as da T6, só revisões.
    const targets =
      changesFromApplied(source.applied) ??
      (await changesFromRevisions(tx, tenantId, source.id));

    const planned: PlannedRevert[] = [];
    const stale: string[] = [];

    for (const target of targets) {
      const entity = await loadEntityForUpdate(tx, tenantId, target.entityType, target.entityId);
      const slug =
        entity !== null ? entity.row.slug : target.slug !== '' ? target.slug : target.entityId;
      if (entity === null || entity.row.version !== target.postVersion) {
        stale.push(slug);
        continue;
      }
      if (target.action === 'create') {
        planned.push({ kind: 'archive', entity });
        continue;
      }
      const snapshot = await snapshotAtVersion(
        tx,
        tenantId,
        target.entityType,
        target.entityId,
        target.preVersion,
      );
      if (snapshot === null) {
        throw new HttpError(409, 'revert_snapshot_missing', `snapshot em falta: ${slug}`);
      }
      planned.push({ kind: 'restore', entity, snapshot });
    }

    if (stale.length > 0) {
      throw new HttpError(
        409,
        'stale_revert',
        `itens alterados depois da publicação: ${stale.join(', ')}`,
        undefined,
        { slugs: [...stale].sort() },
      );
    }

    const archivedCount = planned.filter((plan) => plan.kind === 'archive').length;
    const changes: PublicationChange[] = planned.map((plan) => ({
      entityType: plan.entity.entityType,
      entityId: plan.entity.row.id,
      slug: plan.entity.row.slug,
      action: plan.kind === 'archive' ? 'archive' : 'update',
      preVersion: plan.entity.row.version,
      postVersion: plan.entity.row.version + 1,
    }));

    const [publication] = await tx
      .insert(knowledgePublications)
      .values({
        tenantId,
        kind: 'revert',
        idempotencyKey: randomUUID(),
        createdById: input.changedById,
        applied: {
          added: 0,
          updated: planned.length - archivedCount,
          archived: archivedCount,
          changes,
        },
      })
      .returning({ id: knowledgePublications.id });
    if (publication === undefined) throw new Error('revert: publicação sem returning');

    for (const plan of planned) {
      // Invariante: a entidade foi bloqueada com FOR UPDATE nesta transacção
      // (em `loadEntityForUpdate`, ao planear), logo não há escrita concorrente
      // na mesma versão e o snapshot é idêntico ao já existente por construção —
      // o pré-estado não muda dentro do lock.
      await writeRevision(tx, {
        tenantId,
        entityType: plan.entity.entityType,
        entityId: plan.entity.row.id,
        version: plan.entity.row.version,
        snapshot: plan.entity.snapshot,
        changedById: input.changedById,
        publicationId: publication.id,
        note: 'revert',
        ignoreVersionConflict: true,
      });

      if (plan.kind === 'archive') {
        await archiveEntity(tx, plan.entity, { tenantId, now });
        continue;
      }

      await restoreEntity(tx, plan.entity, plan.snapshot, { tenantId, now });
      if (plan.entity.entityType !== 'rule') {
        await reactivateChunks(tx, {
          tenantId,
          entityType: plan.entity.entityType,
          entityId: plan.entity.row.id,
        });
      }
    }

    reverted = planned.length;
    return publication.id;
  });

  await deps.audit.record({
    tenantId: deps.scope.tenantId,
    actorId: input.changedById,
    action: 'knowledge.reverted',
    entity: 'knowledge_publication',
    entityId: publicationId,
    detail: { sourcePublicationId: input.publicationId, reverted },
    at: deps.now(),
  });

  return { reverted };
}

