// Rotas de plataforma (Onda 1, Task 7; spec multitenant §5.3): lista de
// tenants com contagens, ciclo de vida (suspend/activate) e drill de suporte
// READ-ONLY. TODAS sob `requirePlatform` (a matriz T8 depende destas rotas
// recusarem sessões de tenant; as rotas de tenant ganham o espelho
// `requireTenant`, ruling R2/R15).
//
// O drill é a ÚNICA via cross-tenant sanctionada: o scope vem do path
// `:tenantId` (nunca do corpo — spec §4.5) e CADA acesso a um tenant é
// auditado (`platform.view_tenant`, ruling R22 — a via mais privilegiada
// nunca fica sem audit). Escrita dentro de tenant por
// plataforma = 403 em v1 (impersonation é futuro; as únicas mutações aqui são
// o ciclo de vida do TENANT, auditadas com o tenant afetado, spec §5.4).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../../../domain/error.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requirePlatform } from '../guards.js';

const idParams = z.object({ id: z.uuid() });
const tenantParams = z.object({ tenantId: z.uuid() });
const threadParams = z.object({ tenantId: z.uuid(), id: z.uuid() });

// Mesma paginação do fio de conversas da rota de tenant (cursor opaco, 1–100).
const listQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function platformRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const repo = deps.tenantsRepo;
  const accounts = deps.accounts;
  const conversations = deps.conversations;
  const platform = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requirePlatform(),
  ];

  /** Ciclo de vida: 204 + audit com o tenant AFETADO (spec §5.4);
   *  tenant inexistente → 404 (sem audit — a FK do audit_log não rebenta). */
  const setStatus = async (
    request: FastifyRequest,
    id: string,
    status: 'active' | 'suspended',
    action: string,
  ): Promise<void> => {
    const updated = await repo.setStatus(id, status);
    if (!updated) throw new DomainError('not_found');
    await deps.audit.record({
      tenantId: id, // tenant afetado (não null: a ação é SOBRE ele)
      actorId: request.auth!.userId,
      action,
      entity: 'tenant',
      entityId: id,
      at: deps.now(),
      ip: request.ip,
    });
  };

  /** Drill: scope do path (única via cross-tenant) + audit de CADA acesso
   *  (`platform.view_tenant`, ruling R22 — ver Preocupações do review).
   *  Tenant inexistente → 404 ANTES de qualquer audit/read (nunca 500 pela FK). */
  const drillScope = async (request: FastifyRequest, tenantId: string): Promise<TenantScope> => {
    const tenant = await repo.get(tenantId);
    if (tenant === null) throw new DomainError('not_found');
    await deps.audit.record({
      tenantId, // tenant PERFURADO (drill auditado por acesso, spec §5.3/§6)
      actorId: request.auth!.userId,
      action: 'platform.view_tenant',
      entity: 'tenant',
      entityId: tenantId,
      at: deps.now(),
      ip: request.ip,
    });
    return { tenantId };
  };

  // ── Ciclo de vida ──────────────────────────────────────────────────────────

  app.get('/v1/platform/tenants', { preHandler: platform }, async (_request, reply) =>
    reply.send(await repo.list()),
  );

  app.post('/v1/platform/tenants/:id/suspend', { preHandler: platform }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await setStatus(request, id, 'suspended', 'tenant.suspend');
    return reply.status(204).send();
  });

  app.post('/v1/platform/tenants/:id/activate', { preHandler: platform }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await setStatus(request, id, 'active', 'tenant.activate');
    return reply.status(204).send();
  });

  // ── Drill read-only de suporte ─────────────────────────────────────────────

  app.get('/v1/platform/tenants/:tenantId/users', { preHandler: platform }, async (request, reply) => {
    const { tenantId } = tenantParams.parse(request.params);
    const s = await drillScope(request, tenantId);
    return reply.send({ users: await deps.usersRepo.list(s) });
  });

  if (accounts !== undefined) {
    app.get('/v1/platform/tenants/:tenantId/accounts', { preHandler: platform }, async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      const s = await drillScope(request, tenantId);
      return reply.send({ accounts: await accounts.list(s) });
    });
  }

  if (conversations !== undefined) {
    app.get('/v1/platform/tenants/:tenantId/conversations', { preHandler: platform }, async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      const q = listQuery.parse(request.query);
      const s = await drillScope(request, tenantId);
      const page = await conversations.list(s, { cursor: q.cursor, limit: q.limit });
      return reply.send({ conversations: page.items, nextCursor: page.nextCursor });
    });

    app.get('/v1/platform/tenants/:tenantId/conversations/:id', { preHandler: platform }, async (request, reply) => {
      const { tenantId, id } = threadParams.parse(request.params);
      const s = await drillScope(request, tenantId);
      const found = await conversations.get(s, id);
      if (found === null) throw new DomainError('not_found');
      return reply.send({ conversation: found.conversation, lastMessage: found.lastMessage });
    });
  }
}
