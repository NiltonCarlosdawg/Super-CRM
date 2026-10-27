// Treinar agente, Task 8: retrieve do chat de teste por alvo.
// O alvo `draft` lê os chunks do STAGING (`knowledge_draft_items.chunks`) do
// tenant e pontua-os: cosseno quando há embedder, sobreposição de tokens quando
// não há. O alvo `published` devolve vazio: o retrieve de produção
// (`searchChunks` sobre `knowledge_chunks`) depende do runtime de embeddings,
// que é ADR pendente (ADR-0002/A4) — o chat de teste não inventa fontes do activo.
//
// Os chunks do staging vivem num jsonb sem id próprio: o id citável é sintético
// e estável (`staged:chunk:<slug>:<position>`), e o mesmo para o catálogo
// (`staged:catalog:<slug>`). O slug é a identidade do item dentro do tenant
// (unique `draft_items_tenant_slug_uq`), por isso o id não colide dentro da
// mesma pesquisa — e a query é sempre scoped pelo tenant.

import { and, eq } from 'drizzle-orm';

import type { CatalogFact, RetrievedChunk } from '../../ports/ai-provider.js';
import type { EmbeddingsProvider } from '../../ports/embeddings.js';
import { knowledgeDraftItems } from './knowledge.schema.js';
import type { TrainDeps } from './train-service.js';

/** Alvo do chat de teste: rascunho (staging) ou activo publicado. */
export type ChatTarget = 'draft' | 'published';

/** Máximo de chunks devolvidos (mesmo valor do retrieve de produção). */
export const TOP_K = 5;

/** Abaixo disto a fonte não é fiável o suficiente para citar. */
export const MIN_SIMILARITY = 0.15;

export interface ScorableChunk {
  id: string;
  content: string;
  embedding: readonly number[] | null;
}

export interface ScoredChunk {
  id: string;
  score: number;
}

/** Id citável de um chunk staged (estável dentro do tenant). */
export function stagedChunkId(slug: string, position: number): string {
  return `staged:chunk:${slug}:${position}`;
}

/** Id citável de um facto de catálogo staged (estável dentro do tenant). */
export function stagedCatalogId(slug: string): string {
  return `staged:catalog:${slug}`;
}

/**
 * Tokens minúsculos, sem pontuação e sem diacríticos (a comparação é lexical,
 * não gramatical). Usado pela pontuação de tokens e pelos fixtures que imitam
 * um embedder semântico.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Fração dos tokens (únicos) da query presentes no texto. 0 se a query não tem tokens. */
export function tokenScore(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

/** Cosseno entre dois vetores; 0 se algum for degenerado. */
function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pontua e ordena chunks. Com embedder → cosseno entre a query embebida e cada
 * `embedding` (os `null` são ignorados). Sem embedder → sobreposição de tokens
 * normalizada. Ordena desc, corta em `TOP_K` e descarta `score < MIN_SIMILARITY`.
 */
export async function scoreChunks(
  query: string,
  chunks: ReadonlyArray<ScorableChunk>,
  embedder?: EmbeddingsProvider,
): Promise<ScoredChunk[]> {
  const scored: ScoredChunk[] = [];

  if (embedder !== undefined) {
    const [queryVector] = await embedder.embedTexts([query]);
    if (queryVector === undefined) return [];
    for (const chunk of chunks) {
      if (chunk.embedding === null) continue;
      scored.push({ id: chunk.id, score: cosine(queryVector, chunk.embedding) });
    }
  } else {
    for (const chunk of chunks) {
      scored.push({ id: chunk.id, score: tokenScore(query, chunk.content) });
    }
  }

  return scored
    .filter((chunk) => chunk.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, TOP_K);
}

interface StoredChunk {
  position: number;
  content: string;
  embedding: number[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lê defensivamente o jsonb `chunks` (pode vir de uma versão anterior do staging). */
function readChunks(value: unknown): StoredChunk[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChunk[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { position, content, embedding } = entry;
    if (typeof position !== 'number' || typeof content !== 'string') continue;
    const vector =
      Array.isArray(embedding) && embedding.every((n) => typeof n === 'number')
        ? (embedding as number[])
        : null;
    out.push({ position, content, embedding: vector });
  }
  return out;
}

interface StagedRow {
  id: string;
  slug: string;
  entityType: string;
  baseVersion: number | null;
}

function chunkSource(entityType: string): RetrievedChunk['source'] {
  return entityType === 'catalog_item' ? 'catalog' : 'doc';
}

/**
 * Retrieve do chat de teste para o alvo pedido. `draft` lê o staging do tenant;
 * `published` devolve vazio (ADR de embeddings pendente, ver cabeçalho).
 */
export async function retrieveForTarget(
  deps: TrainDeps,
  query: string,
  target: ChatTarget,
): Promise<RetrievedChunk[]> {
  if (target === 'published') return [];

  const rows = await deps.db
    .select({
      id: knowledgeDraftItems.id,
      slug: knowledgeDraftItems.slug,
      entityType: knowledgeDraftItems.entityType,
      chunks: knowledgeDraftItems.chunks,
      baseVersion: knowledgeDraftItems.baseVersion,
    })
    .from(knowledgeDraftItems)
    .where(eq(knowledgeDraftItems.tenantId, deps.scope.tenantId));

  const byId = new Map<string, { row: StagedRow; content: string }>();
  const scorable: ScorableChunk[] = [];
  for (const row of rows) {
    for (const chunk of readChunks(row.chunks)) {
      const id = stagedChunkId(row.slug, chunk.position);
      byId.set(id, { row, content: chunk.content });
      scorable.push({ id, content: chunk.content, embedding: chunk.embedding });
    }
  }

  const scored = await scoreChunks(query, scorable, deps.embedder);
  return scored.map(({ id, score }) => {
    // `scoreChunks` só devolve ids que entraram em `scorable`/`byId`.
    const hit = byId.get(id)!;
    return {
      id,
      source: chunkSource(hit.row.entityType),
      sourceId: hit.row.id,
      content: hit.content,
      similarity: score,
      // Versão que o item teria ao publicar (o staging ainda não é versão).
      version: (hit.row.baseVersion ?? 0) + 1,
    };
  });
}

function catalogFactFromRow(row: {
  slug: string;
  payload: unknown;
  baseVersion: number | null;
}): { fact: CatalogFact; details: string } | null {
  const payload = row.payload;
  if (!isRecord(payload) || payload.kind !== 'catalog_item') return null;

  const { name, summary, pricingMode, priceAmount, currency, availability, details } = payload;
  if (typeof name !== 'string' || typeof summary !== 'string') return null;
  if (pricingMode !== 'fixed' && pricingMode !== 'from' && pricingMode !== 'quote_only') return null;

  return {
    fact: {
      id: stagedCatalogId(row.slug),
      name,
      summary,
      pricingMode,
      priceAmount: typeof priceAmount === 'string' ? priceAmount : null,
      currency: typeof currency === 'string' ? currency : 'AOA',
      availability:
        availability === 'limited' || availability === 'unavailable' ? availability : 'available',
      version: (row.baseVersion ?? 0) + 1,
    },
    details: isRecord(details) ? JSON.stringify(details) : '',
  };
}

/**
 * Lookup de catálogo do chat de teste. `draft` devolve os factos dos itens de
 * catálogo staged cujo texto (nome, resumo, detalhes) partilha tokens com a
 * query; `published` devolve vazio (mesma razão do retrieve).
 */
export async function lookupCatalogForTarget(
  deps: TrainDeps,
  query: string,
  target: ChatTarget,
): Promise<CatalogFact[]> {
  if (target === 'published') return [];

  const rows = await deps.db
    .select({
      slug: knowledgeDraftItems.slug,
      payload: knowledgeDraftItems.payload,
      baseVersion: knowledgeDraftItems.baseVersion,
    })
    .from(knowledgeDraftItems)
    .where(
      and(
        eq(knowledgeDraftItems.tenantId, deps.scope.tenantId),
        eq(knowledgeDraftItems.entityType, 'catalog_item'),
      ),
    );

  const found: Array<{ fact: CatalogFact; score: number }> = [];
  for (const row of rows) {
    const candidate = catalogFactFromRow(row);
    if (candidate === null) continue;
    const text = `${candidate.fact.name} ${candidate.fact.summary} ${candidate.details}`.trim();
    const score = tokenScore(query, text);
    if (score > 0) found.push({ fact: candidate.fact, score });
  }

  return found
    .sort((a, b) => b.score - a.score || a.fact.name.localeCompare(b.fact.name))
    .map((entry) => entry.fact);
}
