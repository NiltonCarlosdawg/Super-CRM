// Fase 2, Task 2: retrieve do conhecimento PUBLICADO (§7.4) — o retrieve de
// produção, usado pelo orquestrador e pelo chat de teste `target=published`.
//
// Caminho semântico: SQL em pgvector, tenant-scoped, com join ao pai e
// `ORDER BY embedding <=> query` (aproveita o HNSW) — o corpus nunca é carregado
// para Node. Fallback FTS em português (plano B de docs/06) com os MESMOS
// filtros: sem embedder, sem vector correspondente ou erro de inferência, o
// conhecimento continua servível até ao job de reembed (§7.3).
// Nunca inventa fontes: sem resultados → `[]`.

import { sql } from 'drizzle-orm';

import type { LineSlug, RetrievedChunk } from '../../ports/ai-provider.js';
import { resolveLineId, type TrainDeps } from './train-service.js';

/** Defaults iguais aos de `AI_RETRIEVAL_*` (docs/01 §8). */
export interface PublishedRetrieveOptions {
  /** Máximo de chunks devolvidos (default 5). */
  topK?: number;
  /** Limiar SÓ do caminho semântico (default 0.75); o FTS tem ranking próprio. */
  minSimilarity?: number;
}

/** Linha crua de ambas as queries (aliases em snake_case, como o PG devolve). */
interface ChunkRow {
  id: string;
  source: string;
  doc_id: string | null;
  catalog_item_id: string | null;
  content: string;
  similarity: unknown;
  version: unknown;
}

/** Map defensivo: linha malformada (sem pai, versão ou ranking) nunca é servida. */
function toChunks(rows: readonly ChunkRow[]): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  for (const row of rows) {
    const source = row.source === 'doc' ? 'doc' : row.source === 'catalog' ? 'catalog' : null;
    const sourceId = source === 'doc' ? row.doc_id : row.catalog_item_id;
    const similarity = Number(row.similarity);
    const version = Number(row.version);
    if (source === null || sourceId === null || !Number.isFinite(similarity) || !Number.isInteger(version)) {
      continue;
    }
    out.push({ id: row.id, source, sourceId, content: row.content, similarity, version });
  }
  return out;
}

/**
 * Filtros de pai partilhados pelos dois caminhos: publicado, dentro da
 * validade (relógio controlado `$now`) e da linha. Catálogo exige linha
 * (`line_id` NOT NULL): com `lineId` nulo `ci.line_id = NULL` nunca é verdade
 * e o catálogo fica de fora; docs com `line_id` nulo valem para toda a empresa.
 */
function parentFilters(now: Date, lineId: string | null) {
  return sql`
    (c.source = 'doc' AND kd.id IS NOT NULL AND kd.status = 'published'
       AND (kd.valid_from IS NULL OR kd.valid_from <= ${now})
       AND (kd.valid_until IS NULL OR kd.valid_until >= ${now})
       AND (kd.line_id IS NULL OR kd.line_id = ${lineId}))
    OR
    (c.source = 'catalog' AND ci.id IS NOT NULL AND ci.status = 'published'
       AND (ci.valid_from IS NULL OR ci.valid_from <= ${now})
       AND (ci.valid_until IS NULL OR ci.valid_until >= ${now})
       AND ci.line_id = ${lineId})`;
}

export async function retrievePublished(
  deps: TrainDeps,
  query: string,
  line: LineSlug | null,
  opts: PublishedRetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (query.trim() === '') return [];
  const topK = opts.topK ?? 5;
  const minSimilarity = opts.minSimilarity ?? 0.75;
  const now = deps.now();
  const tenantId = deps.scope.tenantId;
  const lineId = line === null ? null : await resolveLineId(deps.db, line);

  if (deps.embedder !== undefined) {
    // shortcut: erro de inferência degrada para FTS sem telemetria — observar
    // pelo job `knowledge.reembed` (que faz rethrow e fica visível na fila).
    let queryVector: number[] | undefined;
    try {
      [queryVector] = await deps.embedder.embedTexts([query], { kind: 'query' });
    } catch {
      queryVector = undefined;
    }

    if (queryVector !== undefined) {
      // O vetor vai em texto `[...]` (formato de entrada do pgvector): passar o
      // array JS directamente faz o PG inferir `record` e falhar o cast.
      const queryVectorText = JSON.stringify(queryVector);
      // Erros desta SQL NÃO são engolidos: um bug no caminho semântico tem de
      // ser visível em vez de mascarar para sempre pelo fallback.
      const res = await deps.db.execute(sql`
        SELECT c.id, c.source, c.doc_id, c.catalog_item_id, c.content,
               (1 - (c.embedding <=> ${queryVectorText}::vector)) AS similarity,
               COALESCE(kd.version, ci.version) AS version
        FROM knowledge_chunks c
        LEFT JOIN knowledge_docs kd ON kd.id = c.doc_id
        LEFT JOIN catalog_items ci ON ci.id = c.catalog_item_id
        WHERE c.tenant_id = ${tenantId}
          AND c.active = true
          AND c.embedding IS NOT NULL
          AND c.embedding_model = ${deps.embedder.model}
          AND (1 - (c.embedding <=> ${queryVectorText}::vector)) >= ${minSimilarity}
          AND (${parentFilters(now, lineId)})
        ORDER BY c.embedding <=> ${queryVectorText}::vector
        LIMIT ${topK}`);
      const hits = toChunks(res.rows as unknown as ChunkRow[]);
      if (hits.length > 0) return hits;
    }
  }

  // Fallback lexical (plano B): mesmos filtros, ranking próprio `ts_rank`.
  const res = await deps.db.execute(sql`
    SELECT c.id, c.source, c.doc_id, c.catalog_item_id, c.content,
           ts_rank(to_tsvector('portuguese', c.content),
                   plainto_tsquery('portuguese', ${query})) AS similarity,
           COALESCE(kd.version, ci.version) AS version
    FROM knowledge_chunks c
    LEFT JOIN knowledge_docs kd ON kd.id = c.doc_id
    LEFT JOIN catalog_items ci ON ci.id = c.catalog_item_id
    WHERE c.tenant_id = ${tenantId}
      AND c.active = true
      AND to_tsvector('portuguese', c.content) @@ plainto_tsquery('portuguese', ${query})
      AND (${parentFilters(now, lineId)})
    ORDER BY similarity DESC, c.id
    LIMIT ${topK}`);
  return toChunks(res.rows as unknown as ChunkRow[]);
}
