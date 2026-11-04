// Treinar agente, Task 7: edição rápida de um item activo, listagem dos itens
// publicados e reversão de publicações. editor|admin (o `agent` não escreve
// conhecimento — spec §9), tenant da sessão em todas as queries e zod em todas
// as entradas (o patch de cada tipo é validado no serviço, com a regra do
// preço). Erros do domínio de treino traduzem-se pela fronteira HTTP.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  listPublications,
  listPublishedItems,
  quickEditItem,
  revertPublication,
} from '../../../modules/knowledge/publish-service.js';
import { listOverdueReviews, markReviewed } from '../../../modules/knowledge/reviews.js';
import { TrainServiceError, type TrainDeps } from '../../../modules/knowledge/train-service.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const idSchema = z.object({ id: z.uuid() });

const entityTypeSchema = z.enum(['catalog_item', 'knowledge_doc', 'rule']);

const quickEditBodySchema = z
  .object({
    entityType: entityTypeSchema,
    // O conteúdo do patch é validado por tipo no serviço (zod parcial).
    patch: z.record(z.string(), z.unknown()),
  })
  .strict();

const revertBodySchema = z.object({ publicationId: z.uuid() }).strict();

const reviewParamsSchema = z.object({ entityType: entityTypeSchema, id: z.uuid() });

/** Paginação simples por `limit` (default 50, máximo 200). */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function knowledgeItemsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  // Registo condicional em app.ts; `!` seguro por isso.
  const knowledge = deps.knowledge!;
  const db = knowledge.db;

  const scope = (request: FastifyRequest): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de conhecimento alcançada sem requireTenant?');
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

  /** Linha por confirmar/existente é 404 na fronteira (mesma ruling da T5). */
  const mapTrainError = (error: unknown): never => {
    if (error instanceof TrainServiceError) {
      throw new HttpError(error.status, error.code, error.message);
    }
    throw error;
  };

  const guard = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireTenant(),
    requireAnyRole('editor', 'admin'),
  ];

  // Edição rápida do dia-a-dia: um item activo, campos parciais por tipo.
  app.patch('/v1/knowledge/items/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = quickEditBodySchema.parse(request.body);
    try {
      const result = await quickEditItem(mkDeps(request), {
        itemId: id,
        entityType: body.entityType,
        patch: body.patch,
        changedById: request.auth!.userId,
      });
      return reply.send(result);
    } catch (error) {
      return mapTrainError(error);
    }
  });

  // Listagem consolidada dos itens activos dos três tipos (substitui o
  // `GET /v1/knowledge/items` do desenho; painel pagina por `limit`).
  app.get('/v1/knowledge/published', { preHandler: guard }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const items = await listPublishedItems(mkDeps(request), query.limit);
    return reply.send({ items });
  });

  // Histórico de publicações: é daqui que o painel tira o id para reverter.
  app.get('/v1/knowledge/publications', { preHandler: guard }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const publications = await listPublications(mkDeps(request), query.limit);
    return reply.send({ publications });
  });

  // Reversão tudo-ou-nada; item alterado depois da publicação ⇒ 409 stale_revert.
  app.post(
    '/v1/knowledge/published/revert',
    { preHandler: guard },
    async (request, reply) => {
      const body = revertBodySchema.parse(request.body);
      try {
        const result = await revertPublication(mkDeps(request), {
          publicationId: body.publicationId,
          changedById: request.auth!.userId,
        });
        return reply.send(result);
      } catch (error) {
        return mapTrainError(error);
      }
    },
  );

  // Fase 2 Task 3 (§5.3): alertas de revisão — só itens vencidos dos três
  // tipos, do mais atrasado para o menos (o painel decide a cadência de polling).
  app.get('/v1/knowledge/reviews', { preHandler: guard }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const items = await listOverdueReviews(mkDeps(request), query.limit);
    return reply.send({ items });
  });

  // Marcação manual de revisão; publicar/editar/reverter já carimbam sozinhos.
  app.post(
    '/v1/knowledge/reviews/:entityType/:id',
    { preHandler: guard },
    async (request, reply) => {
      const params = reviewParamsSchema.parse(request.params);
      const item = await markReviewed(mkDeps(request), {
        entityType: params.entityType,
        id: params.id,
        actorId: request.auth!.userId,
      });
      return reply.send(item);
    },
  );

  // Fase 2 Task 2 (§7.3): backfill de embeddings do activo (chunks sem vetor
  // ou de modelo antigo). Sem embedder o efeito é indispensável → 503 (ao
  // contrário do retrieve, que cai em FTS e continua a servir).
  app.post('/v1/knowledge/reembed', { preHandler: guard }, async (request, reply) => {
    if (knowledge.embedder === undefined) {
      throw new HttpError(
        503,
        'embeddings_unavailable',
        'embeddings locais desligados (EMBEDDINGS_ENABLED=false)',
      );
    }
    const { tenantId } = scope(request);
    await knowledge.jobs.enqueue(
      'knowledge.reembed',
      { tenantId },
      {
        // Chave por pedido: uma chave fixa por tenant ficaria deduped para
        // sempre pelo jobId determinístico do BullMQ (ex.: depois de trocar de
        // modelo não havia como disparar novo reembed). O handler é idempotente
        // por efeito — só preenche o que falta.
        idempotencyKey: `knowledge.reembed:${tenantId}:${knowledge.now().getTime()}`,
        correlationId: tenantId,
      },
    );
    return reply.code(202).send({ queued: true });
  });
}
