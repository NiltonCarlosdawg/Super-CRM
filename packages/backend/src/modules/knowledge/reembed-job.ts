// Fase 2, Task 2: job `knowledge.reembed` (§7.3) — backfill de embeddings do
// tenant. Recebe SÓ `{ tenantId }` (docs/02 §6) e processa os chunks com
// `embedding IS NULL` ou `embedding_model` diferente do actual (incomparáveis
// no cosseno): em lotes, prefixo `passage:` pelo próprio port, UPDATE
// condicional por id (reentrega concorrente não repete efeitos). Sucesso →
// audit `knowledge.reembedded` com a contagem e o modelo; o conteúdo dos
// chunks NUNCA sai daqui para logs. Falha de inferência RE-LANÇA: o modelo é
// indispensável a este job (ao contrário do retrieve, que cai em FTS) e a fila
// tem de a tornar visível.

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DbClient } from '../../adapters/db/index.js';
import type { Audit } from '../../ports/audit.js';
import type { EmbeddingsProvider } from '../../ports/embeddings.js';

const payloadSchema = z.object({ tenantId: z.uuid() }).strict();

/** Tamanho do lote por chamada ao embedder (2× o batch interno do provider). */
const DEFAULT_BATCH_SIZE = 32;
/** Teto de lotes por execução: execuções seguintes continuam onde parou. */
const DEFAULT_MAX_BATCHES = 100;

export interface ReembedJobDeps {
  db: DbClient;
  embedder: EmbeddingsProvider;
  audit: Audit;
  now(): Date;
  /** Overridable nos testes (default 32). */
  batchSize?: number;
  /** Overridable nos testes (default 100). */
  maxBatches?: number;
}

/** Handler do job: valida o payload e processa os chunks do tenant (idempotente). */
export function createReembedHandler(
  deps: ReembedJobDeps,
): (payload: Record<string, unknown>) => Promise<void> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;

  return async (payload) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Payload inválido é bug de programação (a rota só enfileira ids): falha
      // visível na fila, sem processar nada.
      throw new Error('knowledge.reembed: payload inválido (esperado { tenantId })');
    }
    const { tenantId } = parsed.data;
    let total = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const res = await deps.db.execute(sql`
        SELECT id, content FROM knowledge_chunks
        WHERE tenant_id = ${tenantId}
          AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${deps.embedder.model})
        ORDER BY id
        LIMIT ${batchSize}`);
      const rows = res.rows as unknown as Array<{ id: string; content: string }>;
      if (rows.length === 0) break;

      const vectors = await deps.embedder.embedTexts(rows.map((row) => row.content));
      if (vectors.length !== rows.length) {
        throw new Error('knowledge.reembed: o número de vetores não coincide com o dos textos');
      }
      for (const [index, row] of rows.entries()) {
        const vector = JSON.stringify(vectors[index]);
        // Condição repetida no WHERE: uma execução concorrente que já tenha
        // preenchido o chunk não é sobrescrita.
        await deps.db.execute(sql`
          UPDATE knowledge_chunks
          SET embedding = ${vector}::vector, embedding_model = ${deps.embedder.model}
          WHERE id = ${row.id}
            AND tenant_id = ${tenantId}
            AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${deps.embedder.model})`);
      }
      total += rows.length;
      if (rows.length < batchSize) break;
    }

    await deps.audit.record({
      tenantId,
      actorId: null, // ação de sistema (job), não humana
      action: 'knowledge.reembedded',
      entity: 'knowledge_chunk',
      entityId: tenantId,
      detail: { count: total, model: deps.embedder.model },
      at: deps.now(),
    });
  };
}
