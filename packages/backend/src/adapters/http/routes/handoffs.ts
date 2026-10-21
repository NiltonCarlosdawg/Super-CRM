// API de handoffs (Fase 3, Task 14): a fila para o painel humano. agent/admin
// leem; aceitar/resolver/devolver à IA são mutações (CSRF global). O claim é
// atómico — o 1.º a aceitar fica; o outro recebe 409 (docs/02 §8).
// Onda 1: toda a query sob scope da sessão (cross-tenant = 404, nunca 403).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  acceptHandoff,
  resolveHandoff,
  returnConversationToAi,
  type HandoffDeps,
} from '../../../application/handoffs.js';
import { DomainError } from '../../../domain/error.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const idSchema = z.object({ id: z.uuid() });

const listQuery = z.object({
  status: z.enum(['pending']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function handoffsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const h = deps.handoffs;
  if (h === undefined) return;

  const agentOrAdmin = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireTenant(),
    requireAnyRole('agent', 'admin'),
  ];

  const scope = (request: FastifyRequest): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de tenant alcançada sem requireTenant?');
    }
    return { tenantId };
  };

  const mkDeps = (request: FastifyRequest): HandoffDeps => ({
    scope: scope(request),
    queue: h.queue,
    conversations: h.conversations,
    settings: h.settings,
    audit: deps.audit,
    notify: h.notify,
    now: deps.now,
  });

  app.get('/v1/handoffs', { preHandler: agentOrAdmin }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    const items = await h.queue.listPending(scope(request), q.limit);
    return reply.send({ handoffs: items });
  });

  app.get('/v1/handoffs/:id', { preHandler: agentOrAdmin }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const row = await h.queue.get(scope(request), id);
    if (row === null) throw new DomainError('not_found');
    return reply.send({ handoff: row });
  });

  app.post('/v1/handoffs/:id/accept', { preHandler: agentOrAdmin }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await acceptHandoff(mkDeps(request), id, request.auth!.userId);
    if (result === 'taken') throw new HttpError(409, 'handoff_taken', 'este handoff já foi aceite por outro colega');
    if (result === 'not_found') throw new DomainError('not_found');
    return reply.send({ status: result });
  });

  app.post('/v1/handoffs/:id/resolve', { preHandler: agentOrAdmin }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await resolveHandoff(mkDeps(request), id, request.auth!.userId);
    if (result === 'not_found') throw new DomainError('not_found');
    return reply.send({ status: result });
  });

  app.post('/v1/conversations/:id/return-to-ai', { preHandler: agentOrAdmin }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await returnConversationToAi(mkDeps(request), id, request.auth!.userId);
    return reply.send(result);
  });
}
