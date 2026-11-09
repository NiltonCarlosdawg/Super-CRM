// Fase 4, Task 11: API REST de campanhas. Todas as rotas atrás de sessão +
// CSRF + `requireRole('admin')` + `requireTenant`; as mutações de criação e
// início exigem `Idempotency-Key` (o replay devolve o mesmo recurso).
// O `CampaignError` dos casos de uso mapeia-se direto para problem+json.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate, requireRole, requireTenant } from '../guards.js';
import { CampaignError } from '../../../application/campaigns/create-campaign.js';

const idSchema = z.object({ id: z.guid() });

const createSchema = z.object({
  name: z.string().min(1).max(120),
  messageTemplate: z.string().min(1).max(4096),
  allowedAccountIds: z.array(z.guid()).min(1).max(10),
  dailyLimit: z.number().int().min(1).nullable(),
});

const startSchema = z.object({ scheduledAt: z.iso.datetime().nullable().optional() });

const listQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** `CampaignError` → HttpError; qualquer outro erro segue para o handler global. */
function mapCampaignError(err: unknown): never {
  if (err instanceof CampaignError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

/** Header obrigatório; os nomes chegam em minúsculas ao Fastify. */
function idempotencyKey(request: { headers: Record<string, unknown> }): string {
  const raw = request.headers['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key === '') {
    throw new HttpError(400, 'validation_failed', "header 'Idempotency-Key' obrigatório (identificador único)");
  }
  return key;
}

export async function campaignsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const bundle = deps.campaigns;
  if (bundle === undefined) return;

  const adminOnly = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireRole('admin'),
    requireTenant(),
  ];

  const scope = (request: { auth?: { tenantId: string | null } }): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de tenant alcançada sem requireTenant?');
    }
    return { tenantId };
  };

  app.post('/v1/campaigns', { preHandler: adminOnly }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const key = idempotencyKey(request);
    const s = scope(request);
    try {
      const result = await bundle.createCampaign(s)({
        ...body,
        idempotencyKey: key,
        actorId: request.auth!.userId,
      });
      return reply.status(result.replayed ? 200 : 201).send(result);
    } catch (err) {
      mapCampaignError(err);
    }
  });

  app.post('/v1/campaigns/:id/start', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = startSchema.parse(request.body ?? {});
    const key = idempotencyKey(request);
    const now = deps.now();
    const s = scope(request);
    try {
      const result = await bundle.startCampaign(s)({
        campaignId: id,
        idempotencyKey: key,
        actorId: request.auth!.userId,
        scheduledAt: body.scheduledAt === undefined || body.scheduledAt === null ? null : new Date(body.scheduledAt),
        now,
      });
      return reply.send(result);
    } catch (err) {
      mapCampaignError(err);
    }
  });

  app.post('/v1/campaigns/:id/pause', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const now = deps.now();
    try {
      const result = await bundle.pauseCampaign(scope(request))({
        campaignId: id,
        accountId: null,
        reason: 'human',
        actorId: request.auth!.userId,
        now,
      });
      if (result.paused === null) {
        throw new HttpError(409, 'invalid_status', 'só campanhas a correr ou agendadas podem ser pausadas');
      }
      return reply.send({ campaign: result.paused });
    } catch (err) {
      mapCampaignError(err);
    }
  });

  app.post('/v1/campaigns/:id/resume', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    try {
      const result = await bundle.resumeCampaign(scope(request))({
        campaignId: id,
        actorId: request.auth!.userId,
        now: deps.now(),
      });
      return reply.send(result);
    } catch (err) {
      mapCampaignError(err);
    }
  });

  app.get('/v1/campaigns', { preHandler: adminOnly }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    const page = await bundle.repository.list(scope(request), { limit: q.limit, cursor: q.cursor ?? null });
    return reply.send(page);
  });

  app.get('/v1/campaigns/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const s = scope(request);
    const campaign = await bundle.repository.findById(s, id);
    if (campaign === null) throw new HttpError(404, 'not_found', 'campanha não encontrada');
    const counts = await bundle.recipients.counts(s, id);
    return reply.send({ campaign, counts });
  });
}
