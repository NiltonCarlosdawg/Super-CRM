// Treinar agente, Task 8 + Fase 2 Task 2: chat de teste
// (`POST /v1/knowledge/chat/test`). editor|admin (o `agent` não escreve
// conhecimento — spec §9), tenant da sessão em todas as queries, zod estrito na
// entrada. Compõe os ports do orquestrador com um retrieve/lookup do ALVO pedido:
//   • `draft`    → chunks e catálogo do staging do tenant (o que se está a treinar);
//   • `published`→ `retrievePublished` (pgvector + FTS, §7.4) e o lookup de
//     catálogo dos ports de produção; `lineSlug` (opcional) escolhe a linha —
//     sem linha segue o comportamento real (catálogo=[], só docs globais).
// A conversa é sintética (`is_test = true`, `line_id = null`) e reutilizada entre
// chamadas; `createTestChat` corre o orquestrador com `isTest: true` e devolve
// `{ reply, sources }` a partir do `answer_trace` (fonte única).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Ports } from '../../../ports/ai-provider.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import {
  lookupCatalogForTarget,
  retrieveForTarget,
  type ChatTarget,
} from '../../../modules/knowledge/draft-retrieval.js';
import { retrievePublished } from '../../../modules/knowledge/published-retrieval.js';
import { createTestChat } from '../../../modules/knowledge/test-chat.js';
import { ensureTestConversation } from '../../../modules/knowledge/test-conversation.js';
import {
  resolveLineId,
  TrainServiceError,
  type TrainDeps,
} from '../../../modules/knowledge/train-service.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const chatBodySchema = z
  .object({
    text: z.string().min(1).max(2000),
    target: z.enum(['draft', 'published']).default('published'),
    /** Vocabulário do domínio (docs/01 §6): só no alvo published; nunca se adivinha. */
    lineSlug: z.enum(['software', 'custom', 'telecom', 'cctv']).optional(),
  })
  .strict();

export async function knowledgeChatTestRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  // Registo condicional em app.ts; `!` seguro por isso.
  const knowledge = deps.knowledge!;
  const db = knowledge.db;

  const scope = (request: FastifyRequest): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de chat de teste sem requireTenant?');
    }
    return { tenantId };
  };

  const mkDeps = (request: FastifyRequest): TrainDeps => ({
    db,
    scope: scope(request),
    audit: knowledge.audit,
    now: knowledge.now,
    ...(knowledge.embedder !== undefined ? { embedder: knowledge.embedder } : {}),
  });

  const guard = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireTenant(),
    requireAnyRole('editor', 'admin'),
  ];

  app.post('/v1/knowledge/chat/test', { preHandler: guard }, async (request, reply) => {
    const body = chatBodySchema.parse(request.body);
    const target: ChatTarget = body.target;

    // Sem a fábrica de ports do orquestrador não há como ler o conhecimento:
    // 503 explícito em vez de uma resposta inventada (docs/02 §1).
    const factory = knowledge.portsFactory;
    if (factory === undefined) {
      throw new HttpError(
        503,
        'knowledge_ports_unavailable',
        'ports do orquestrador não montados nesta instância',
      );
    }

    const trainDeps = mkDeps(request);
    const base = factory.forTenant(trainDeps.scope.tenantId);
    const line = body.lineSlug ?? null;
    // Linha referenciada tem de existir (nunca se adivinha): 404 cedo, antes
    // de correr o chat, para o utilizador ver o erro na fronteira HTTP.
    if (target === 'published' && line !== null) {
      try {
        await resolveLineId(db, line);
      } catch (error) {
        if (error instanceof TrainServiceError) {
          throw new HttpError(error.status, error.code, error.message);
        }
        throw error;
      }
    }
    const ports: Ports = {
      ...base,
      retrieve:
        target === 'published'
          ? (query) =>
              retrievePublished(trainDeps, query, line, {
                topK: knowledge.aiCfg.retrievalTopK,
                minSimilarity: knowledge.aiCfg.retrievalMinSimilarity,
              })
          : (query) => retrieveForTarget(trainDeps, query, target),
      lookupCatalog:
        target === 'published'
          ? (query) => base.lookupCatalog(query, line)
          : (query) => lookupCatalogForTarget(trainDeps, query, target),
    };

    const conversationId = await ensureTestConversation(db, trainDeps.scope.tenantId);
    const testChat = createTestChat({
      ports,
      provider: knowledge.provider,
      settings: knowledge.settings,
      aiCfg: knowledge.aiCfg,
      conversationId,
      db,
    });

    const result = await testChat({ text: body.text });
    return reply.send(result);
  });
}
