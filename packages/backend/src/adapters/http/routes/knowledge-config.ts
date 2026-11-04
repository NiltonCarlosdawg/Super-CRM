import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createConfig, deleteConfig, listConfig, updateConfig } from '../../../modules/knowledge/config-service.js';
import type { TrainDeps } from '../../../modules/knowledge/train-service.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const kindSchema = z.enum(['qualification_question', 'handoff_trigger']);
const paramsSchema = z.object({ kind: kindSchema, id: z.uuid() });
const bodySchema = z.object({
  lineSlug: z.string().nullable().optional(), key: z.string().min(1).max(100).optional(), question: z.string().min(1).optional(),
  answerType: z.enum(['text', 'number', 'choice']).optional(), choices: z.unknown().optional(), required: z.boolean().optional(), position: z.number().int().min(0).optional(),
  code: z.string().min(1).max(100).optional(), description: z.string().min(1).optional(), detectionHint: z.string().min(1).optional(),
  action: z.enum(['handoff_now', 'handoff_when_qualified', 'flag_only']).optional(), priority: z.enum(['normal', 'high', 'urgent']).optional(), active: z.boolean().optional(),
  expectedVersion: z.number().int().min(0).optional(),
}).strict();

export async function knowledgeConfigRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const knowledge = deps.knowledge!;
  const guard = [authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }), requireTenant(), requireAnyRole('editor', 'admin')];
  const scope = (r: FastifyRequest): TenantScope => ({ tenantId: r.auth!.tenantId! });
  const mk = (r: FastifyRequest): TrainDeps => ({ db: knowledge.db, scope: scope(r), audit: knowledge.audit, now: knowledge.now });

  app.get('/v1/knowledge/config/:kind', { preHandler: guard }, async (request, reply) => {
    const { kind } = z.object({ kind: kindSchema }).parse(request.params);
    return reply.send({ items: await listConfig(mk(request), kind) });
  });
  app.post('/v1/knowledge/config/:kind', { preHandler: guard }, async (request, reply) => {
    const { kind } = z.object({ kind: kindSchema }).parse(request.params);
    const body = bodySchema.parse(request.body);
    const item = await createConfig(mk(request), kind, body, request.auth!.userId);
    await knowledge.audit.record({ tenantId: scope(request).tenantId, actorId: request.auth!.userId, action: 'knowledge.config_created', entity: kind, entityId: (item as { id: string }).id, detail: {}, at: knowledge.now() });
    return reply.code(201).send(item);
  });
  app.patch('/v1/knowledge/config/:kind/:id', { preHandler: guard }, async (request, reply) => {
    const p = paramsSchema.parse(request.params); const b = bodySchema.parse(request.body);
    if (b.expectedVersion === undefined) throw new z.ZodError([{ code: 'custom', path: ['expectedVersion'], message: 'obrigatório' }]);
    const item = await updateConfig(mk(request), p.kind, p.id, b, b.expectedVersion, request.auth!.userId);
    return reply.send(item);
  });
  app.delete('/v1/knowledge/config/:kind/:id', { preHandler: guard }, async (request, reply) => {
    const p = paramsSchema.parse(request.params); const q = z.object({ expectedVersion: z.coerce.number().int().min(0) }).parse(request.query);
    await deleteConfig(mk(request), p.kind, p.id, q.expectedVersion, request.auth!.userId);
    return reply.code(204).send();
  });
}
