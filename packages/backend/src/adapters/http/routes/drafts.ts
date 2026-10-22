// API de rascunhos (Fase 3, Task 18): o painel lê os rascunhos por conversa e
// aprova/rejeita. agent/editor/admin (docs/05 §2); CSRF global nas mutações.
// Onda 1: toda a query sob scope da sessão (cross-tenant = 404, nunca 403).
// Sem eventos Socket.IO novos (lista fechada em docs/01/docs/02) — REST.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { approveDraft, listDrafts, rejectDraft, type DraftDeps } from '../../../modules/drafts/service.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const idSchema = z.object({ id: z.uuid() });
const rejectBody = z.object({ reason: z.string().min(1).max(500) });

export async function draftsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  // Só registado com db + outbox presentes (guard no app.ts); `!` seguro por isso.
  const db = deps.db!;
  const outbox = deps.outbox!;

  const scope = (request: FastifyRequest): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de tenant alcançada sem requireTenant?');
    }
    return { tenantId };
  };

  const mkDeps = (request: FastifyRequest): DraftDeps => ({
    db,
    scope: scope(request),
    outbox,
    audit: deps.audit,
    now: deps.now,
  });

  const canApprove = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireTenant(),
    requireAnyRole('agent', 'editor', 'admin'),
  ];

  app.get('/v1/conversations/:id/drafts', { preHandler: canApprove }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const drafts = await listDrafts(mkDeps(request), id);
    return reply.send({ drafts });
  });

  app.post('/v1/drafts/:id/approve', { preHandler: canApprove }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await approveDraft(mkDeps(request), id, request.auth!.userId);
    return reply.send(result);
  });

  app.post('/v1/drafts/:id/reject', { preHandler: canApprove }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = rejectBody.parse(request.body);
    const result = await rejectDraft(mkDeps(request), id, request.auth!.userId, body.reason);
    return reply.send(result);
  });
}
