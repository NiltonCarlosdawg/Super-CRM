// Treinar agente, Task 4: serviço do rascunho e do upload.
// O fluxo escreve SEMPRE em `knowledge_draft_items` (nada fica activo) e o job
// de extração chama `stageExtracted`. Toda a query leva o tenant do scope;
// cross-tenant é indistinguível de inexistente (`not_found`).
//
// `baseVersion`: marcador de versão de origem para a deteção de corridas da
// validação (spec §6). `catalog_items`, `knowledge_docs` e `rules` têm `slug`
// e `version`, por isso a versão activa resolve-se por tenant + slug. Os
// restantes kinds ficam com `baseVersion: null`.

import { and, asc, eq } from 'drizzle-orm';

import type { DbClient } from '../../adapters/db/index.js';
import { DomainError } from '../../domain/error.js';
import type { ExtractedItem, LineSlug } from '../../ports/ai-provider.js';
import type { Audit } from '../../ports/audit.js';
import type { EmbeddingsProvider } from '../../ports/embeddings.js';
import type { JobQueue } from '../../ports/job-queue.js';
import type { TenantScope } from '../../ports/tenancy.js';
import { chunkCatalogItemText, chunkText } from './chunking.js';
import {
  businessLines,
  catalogItems,
  knowledgeDocs,
  knowledgeDraftItems,
  knowledgeTrainUploads,
  rules,
  type DraftEntityType,
  type StagedItemRow,
  type UploadRow,
} from './knowledge.schema.js';

/** Dependências das operações do rascunho (compostas por pedido na rota). */
export interface TrainDeps {
  db: DbClient;
  scope: TenantScope;
  audit: Audit;
  now(): Date;
  /** Sem embedder (ADR de runtime pendente) os chunks ficam com `embedding: null`. */
  embedder?: EmbeddingsProvider;
}

/** Códigos de validação do domínio de treino (mapeados na rota). */
export type TrainErrorCode = 'line_not_found' | 'line_required';

export class TrainServiceError extends Error {
  constructor(
    readonly code: TrainErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TrainServiceError';
  }
}

/** Chunk pronto para o jsonb do rascunho (T2 calcula o vetor, ou null). */
export interface StagedChunk {
  position: number;
  content: string;
  embedding: number[] | null;
}

export interface DraftItemPatch {
  payload?: Record<string, unknown>;
  lineSlug?: string;
  confirmLine?: boolean;
}

export interface NewUploadInput {
  filename: string;
  mediaType: string;
  text: string;
  lineSlug: LineSlug | null;
  lineConfirmed: boolean;
  changedById: string;
}

export interface QueueExtractionDeps {
  db: DbClient;
  scope: TenantScope;
  jobs: JobQueue;
  now(): Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Conteúdo dos chunks por tipo de payload (regras da T2). */
function chunkContentsFor(payload: Record<string, unknown>): string[] {
  switch (payload.kind) {
    case 'knowledge_doc':
      return typeof payload.body === 'string' ? chunkText(payload.body) : [];
    case 'catalog_item':
      return typeof payload.name === 'string' && typeof payload.summary === 'string'
        ? chunkCatalogItemText({
            name: payload.name,
            summary: payload.summary,
            details: isRecord(payload.details) ? payload.details : null,
          })
        : [];
    case 'rule':
      // Regras não entram na pesquisa semântica (vão por `rules()`).
      return [];
    default:
      return [];
  }
}

/** Vetoriza grupos de chunks numa única chamada; sem embedder `embedding = null`. */
async function buildChunkGroups(
  groups: readonly (readonly string[])[],
  embedder: EmbeddingsProvider | undefined,
): Promise<StagedChunk[][]> {
  const texts = groups.flat();
  let vectors: readonly number[][] = [];
  if (texts.length > 0 && embedder !== undefined) {
    vectors = await embedder.embedTexts(texts);
    if (vectors.length !== texts.length) {
      throw new Error('embeddings: o número de vetores não coincide com o dos textos');
    }
  }

  let cursor = 0;
  return groups.map((contents) =>
    contents.map((content, position) => {
      const vector = embedder === undefined ? undefined : vectors[cursor];
      if (embedder !== undefined && vector === undefined) {
        throw new Error('embeddings: vetor em falta');
      }
      cursor += 1;
      return {
        position,
        content,
        embedding: vector === undefined ? null : [...vector],
      };
    }),
  );
}

/** Vetoriza os chunks de UM item (usado pela correção de payload no PATCH). */
async function buildChunks(
  contents: readonly string[],
  embedder: EmbeddingsProvider | undefined,
): Promise<StagedChunk[]> {
  const [group] = await buildChunkGroups([contents], embedder);
  return group ?? [];
}

/**
 * Resolve o id de uma linha de negócio. Uma linha em falta é um recurso
 * referenciado que não existe ⇒ `line_not_found` (404 em todas as rotas de
 * treino, ruling da revisão da T5). Usado pelo upload (`assertLineExists`) e
 * pela validação atómica (T6), que precisa do `lineId` para publicar.
 */
export async function resolveLineId(db: DbClient, slug: string): Promise<string> {
  const [row] = await db
    .select({ id: businessLines.id })
    .from(businessLines)
    .where(eq(businessLines.slug, slug))
    .limit(1);
  if (row === undefined) {
    throw new TrainServiceError('line_not_found', 404, `linha de negócio inexistente: ${slug}`);
  }
  return row.id;
}

async function assertLineExists(db: DbClient, slug: string): Promise<void> {
  await resolveLineId(db, slug);
}

/** Versão activa para o item staged (identidade por tenant + slug). */
async function activeVersion(
  deps: TrainDeps,
  entityType: DraftEntityType,
  slug: string,
): Promise<number | null> {
  switch (entityType) {
    case 'catalog_item': {
      const [row] = await deps.db
        .select({ version: catalogItems.version })
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.tenantId, deps.scope.tenantId),
            eq(catalogItems.slug, slug),
            eq(catalogItems.status, 'published'),
          ),
        )
        .limit(1);
      return row?.version ?? null;
    }
    case 'knowledge_doc': {
      const [row] = await deps.db
        .select({ version: knowledgeDocs.version })
        .from(knowledgeDocs)
        .where(
          and(
            eq(knowledgeDocs.tenantId, deps.scope.tenantId),
            eq(knowledgeDocs.slug, slug),
            eq(knowledgeDocs.status, 'published'),
          ),
        )
        .limit(1);
      return row?.version ?? null;
    }
    case 'rule': {
      const [row] = await deps.db
        .select({ version: rules.version })
        .from(rules)
        .where(
          and(
            eq(rules.tenantId, deps.scope.tenantId),
            eq(rules.slug, slug),
            eq(rules.status, 'published'),
          ),
        )
        .limit(1);
      return row?.version ?? null;
    }
    default:
      return null;
  }
}

/** Linha do upload aplicável ao item: linha confirmada manda; senão a proposta. */
function effectiveLine(
  uploads: readonly UploadRow[],
  item: ExtractedItem,
): { lineSlug: string | null; lineConfirmed: boolean } {
  const confirmedLine = uploads.find((u) => u.lineConfirmed && u.lineSlug !== null)?.lineSlug ?? null;
  const inheritedLine = uploads.find((u) => u.lineSlug !== null)?.lineSlug ?? null;

  if (confirmedLine !== null && (item.lineSlug === null || item.lineSlug === confirmedLine)) {
    return { lineSlug: confirmedLine, lineConfirmed: true };
  }
  // Proposta diferente da pré-seleção: mantém-se a proposta, por confirmar.
  return { lineSlug: item.lineSlug ?? inheritedLine, lineConfirmed: false };
}

/**
 * Coloca os itens extraídos no rascunho do tenant (upsert por `(tenantId, slug)`).
 * Valida todas as linhas antes de escrever (sem efeitos parciais) e calcula os
 * chunks/embeddings fora da transacção (rede/lento). Audit `knowledge.staged`.
 */
export async function stageExtracted(
  deps: TrainDeps,
  input: { uploads: UploadRow[]; items: ExtractedItem[]; changedById: string },
): Promise<StagedItemRow[]> {
  const resolved = input.items.map((item) => ({ item, ...effectiveLine(input.uploads, item) }));

  // Validação primeiro: slug de linha desconhecido ⇒ erro sem escrever nada.
  const lineSlugs = [...new Set(resolved.map((r) => r.lineSlug).filter((s): s is string => s !== null))];
  for (const slug of lineSlugs) await assertLineExists(deps.db, slug);

  const chunksPerItem = await buildChunkGroups(
    resolved.map((r) => chunkContentsFor(r.item.payload as Record<string, unknown>)),
    deps.embedder,
  );

  const baseVersions = await Promise.all(
    resolved.map((r) => activeVersion(deps, r.item.payload.kind, r.item.slug)),
  );

  const rows = await deps.db.transaction(async (tx) => {
    const out: StagedItemRow[] = [];
    for (const [index, r] of resolved.entries()) {
      const [row] = await tx
        .insert(knowledgeDraftItems)
        .values({
          tenantId: deps.scope.tenantId,
          slug: r.item.slug,
          entityType: r.item.payload.kind,
          op: r.item.op,
          lineSlug: r.lineSlug,
          lineConfirmed: r.lineConfirmed,
          payload: r.item.payload,
          chunks: chunksPerItem[index] ?? [],
          baseVersion: baseVersions[index] ?? null,
          changedById: input.changedById,
          updatedAt: deps.now(),
        })
        .onConflictDoUpdate({
          target: [knowledgeDraftItems.tenantId, knowledgeDraftItems.slug],
          set: {
            entityType: r.item.payload.kind,
            op: r.item.op,
            lineSlug: r.lineSlug,
            lineConfirmed: r.lineConfirmed,
            payload: r.item.payload,
            chunks: chunksPerItem[index] ?? [],
            baseVersion: baseVersions[index] ?? null,
            changedById: input.changedById,
            updatedAt: deps.now(),
          },
        })
        .returning();
      if (row === undefined) throw new Error('knowledge.staged: upsert sem returning');
      out.push(row);
    }
    return out;
  });

  if (rows.length > 0) {
    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: input.changedById,
      action: 'knowledge.staged',
      entity: 'knowledge_train_upload',
      entityId: input.uploads[0]?.id ?? deps.scope.tenantId,
      detail: { items: rows.length, slugs: rows.map((r) => r.slug) },
      at: deps.now(),
    });
  }
  return rows;
}

/** Itens do rascunho do tenant, pela ordem em que foram criados/atualizados. */
export async function listDraftItems(deps: TrainDeps): Promise<StagedItemRow[]> {
  return deps.db
    .select()
    .from(knowledgeDraftItems)
    .where(eq(knowledgeDraftItems.tenantId, deps.scope.tenantId))
    .orderBy(asc(knowledgeDraftItems.createdAt), asc(knowledgeDraftItems.id));
}

async function loadDraftItem(deps: TrainDeps, id: string): Promise<StagedItemRow> {
  const [row] = await deps.db
    .select()
    .from(knowledgeDraftItems)
    .where(and(eq(knowledgeDraftItems.id, id), eq(knowledgeDraftItems.tenantId, deps.scope.tenantId)))
    .limit(1);
  if (row === undefined) throw new DomainError('not_found');
  return row;
}

/**
 * Corrige um item staged: `payload` faz merge raso com o existente (o painel
 * pode enviar só os campos alterados) e recalcula os chunks; `lineSlug` valida
 * contra `business_lines`; `confirmLine` exige uma linha definida.
 */
export async function patchDraftItem(
  deps: TrainDeps,
  id: string,
  patch: DraftItemPatch,
): Promise<StagedItemRow> {
  const current = await loadDraftItem(deps, id);

  let lineSlug = current.lineSlug;
  let lineConfirmed = current.lineConfirmed;
  if (patch.lineSlug !== undefined) {
    await assertLineExists(deps.db, patch.lineSlug);
    if (patch.lineSlug !== current.lineSlug) lineConfirmed = false;
    lineSlug = patch.lineSlug;
  }
  if (patch.confirmLine === true) {
    if (lineSlug === null) {
      throw new TrainServiceError('line_required', 422, 'confirmar a linha exige uma linha de negócio definida');
    }
    lineConfirmed = true;
  } else if (patch.confirmLine === false) {
    lineConfirmed = false;
  }

  let payload = current.payload as Record<string, unknown>;
  let chunks = current.chunks;
  if (patch.payload !== undefined) {
    payload = { ...payload, ...patch.payload };
    chunks = await buildChunks(chunkContentsFor(payload), deps.embedder);
  }

  const [updated] = await deps.db
    .update(knowledgeDraftItems)
    .set({ payload, chunks, lineSlug, lineConfirmed, updatedAt: deps.now() })
    .where(and(eq(knowledgeDraftItems.id, id), eq(knowledgeDraftItems.tenantId, deps.scope.tenantId)))
    .returning();
  if (updated === undefined) throw new DomainError('not_found');
  return updated;
}

/** Remove o item staged (cancela a alteração); o activo nunca é tocado. */
export async function deleteDraftItem(deps: TrainDeps, id: string): Promise<void> {
  const removed = await deps.db
    .delete(knowledgeDraftItems)
    .where(and(eq(knowledgeDraftItems.id, id), eq(knowledgeDraftItems.tenantId, deps.scope.tenantId)))
    .returning({ id: knowledgeDraftItems.id });
  if (removed.length === 0) throw new DomainError('not_found');
}

/**
 * Transcrição do fluxo guiado: uma linha por pergunta e outra por resposta,
 * pares separados por linha em branco, na ordem em que o editor respondeu.
 * É este texto que entra no pipeline como upload `text/plain` (T5).
 */
export function formatGuidedTranscript(
  answers: ReadonlyArray<{ question: string; answer: string }>,
): string {
  return answers
    .map(({ question, answer }) => `Pergunta: ${question}\nResposta: ${answer}`)
    .join('\n\n');
}

/**
 * Cria o upload (`status: 'pending'`) e enfileira `knowledge.extract` com um
 * payload de SÓ ids. Helper partilhado pela rota de documentos (T4) e pelo
 * fluxo guiado (T5).
 */
export async function queueExtraction(
  deps: QueueExtractionDeps,
  input: NewUploadInput,
  opts?: { correlationId?: string },
): Promise<string> {
  if (input.lineSlug !== null) await assertLineExists(deps.db, input.lineSlug);

  const [row] = await deps.db
    .insert(knowledgeTrainUploads)
    .values({
      tenantId: deps.scope.tenantId,
      filename: input.filename,
      mediaType: input.mediaType,
      text: input.text,
      status: 'pending',
      lineSlug: input.lineSlug,
      lineConfirmed: input.lineConfirmed,
      changedById: input.changedById,
      updatedAt: deps.now(),
    })
    .returning({ id: knowledgeTrainUploads.id });
  if (row === undefined) throw new Error('falha ao criar upload de treino');

  await deps.jobs.enqueue(
    'knowledge.extract',
    { uploadId: row.id },
    {
      idempotencyKey: `knowledge.extract:${row.id}`,
      correlationId: opts?.correlationId ?? row.id,
    },
  );
  return row.id;
}
