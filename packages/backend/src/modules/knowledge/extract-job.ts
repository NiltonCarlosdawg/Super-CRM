// Treinar agente, Task 4: job `knowledge.extract`.
// Recebe SÓ `{ uploadId }` (docs/02 §6) e faz CAS `pending → processing` para
// garantir que uma reentrega não repete o staging. Sucesso → `done` + audit
// `knowledge.extracted`; falha → `error` com mensagem CURTA (nunca o conteúdo
// do documento) e SEM re-lançar: um documento inválido não fica em retry
// infinito, e o utilizador vê a falha e corrige/re-uploadeia. O activo nunca é
// tocado — o staging escreve exclusivamente em `knowledge_draft_items`.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { DbClient } from '../../adapters/db/index.js';
import type { AIProvider } from '../../ports/ai-provider.js';
import type { Audit } from '../../ports/audit.js';
import type { EmbeddingsProvider } from '../../ports/embeddings.js';
import { knowledgeTrainUploads } from './knowledge.schema.js';
import { parseUpload, UnsupportedFormatError } from './parsers.js';
import { stageExtracted, TrainServiceError } from './train-service.js';

const payloadSchema = z.object({ uploadId: z.uuid() }).strict();

export interface ExtractJobDeps {
  db: DbClient;
  provider: AIProvider;
  embedder?: EmbeddingsProvider;
  audit: Audit;
  now(): Date;
  logger: { warn(obj: object, msg?: string): void };
}

/**
 * Mensagem curta e determinística para o utilizador. Nunca inclui
 * `error.message` de origens desconhecidas: poderia ecoar o documento ou SQL.
 * Os nomes `AIValidationError`/`LLMError` vêm do AIProvider (T3).
 */
function shortError(error: unknown): string {
  if (error instanceof UnsupportedFormatError) return 'unsupported_format';
  if (error instanceof TrainServiceError) return error.code;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AIValidationError') return 'extraction_invalid';
  if (name === 'LLMError') return 'llm_error';
  return 'extraction_failed';
}

/** Handler do job: valida o payload e processa UM upload (idempotente). */
export function createExtractHandler(
  deps: ExtractJobDeps,
): (payload: Record<string, unknown>) => Promise<void> {
  return async (payload) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Payload inválido é bug de programação (a rota só enfileira ids): falha
      // visível na fila, sem processar nada.
      throw new Error('knowledge.extract: payload inválido (esperado { uploadId })');
    }
    const { uploadId } = parsed.data;

    // CAS pending → processing (idempotência: reentrega não repete efeitos).
    const [claimed] = await deps.db
      .update(knowledgeTrainUploads)
      .set({ status: 'processing', updatedAt: deps.now() })
      .where(
        and(eq(knowledgeTrainUploads.id, uploadId), eq(knowledgeTrainUploads.status, 'pending')),
      )
      .returning();
    if (claimed === undefined) {
      const [existing] = await deps.db
        .select({ id: knowledgeTrainUploads.id })
        .from(knowledgeTrainUploads)
        .where(eq(knowledgeTrainUploads.id, uploadId))
        .limit(1);
      if (existing === undefined) {
        throw new Error(`knowledge.extract: upload ${uploadId} inexistente`);
      }
      return; // já done/processing/error
    }

    try {
      // O texto já foi extraído na rota; re-parse valida o formato guardado.
      const { text } = parseUpload(claimed.mediaType, Buffer.from(claimed.text, 'utf8'));
      const { items } = await deps.provider.extractKnowledge({ text });
      const staged = await stageExtracted(
        {
          db: deps.db,
          scope: { tenantId: claimed.tenantId },
          audit: deps.audit,
          now: deps.now,
          embedder: deps.embedder,
        },
        { uploads: [claimed], items, changedById: claimed.changedById },
      );

      await deps.db
        .update(knowledgeTrainUploads)
        .set({ status: 'done', error: null, updatedAt: deps.now() })
        .where(
          and(
            eq(knowledgeTrainUploads.id, uploadId),
            eq(knowledgeTrainUploads.tenantId, claimed.tenantId),
          ),
        );
      await deps.audit.record({
        tenantId: claimed.tenantId,
        actorId: null, // ação de sistema (job), não humana
        action: 'knowledge.extracted',
        entity: 'knowledge_train_upload',
        entityId: uploadId,
        detail: { items: staged.length },
        at: deps.now(),
      });
    } catch (error) {
      const reason = shortError(error);
      await deps.db
        .update(knowledgeTrainUploads)
        .set({ status: 'error', error: reason, updatedAt: deps.now() })
        .where(
          and(
            eq(knowledgeTrainUploads.id, uploadId),
            eq(knowledgeTrainUploads.tenantId, claimed.tenantId),
          ),
        );
      // Sem rethrow por desenho: o upload fica `error` e visível; retries não
      // ajudam um documento inválido nem um slug de linha desconhecido.
      deps.logger.warn({ uploadId, reason }, 'knowledge.extract.failed');
    }
  };
}
