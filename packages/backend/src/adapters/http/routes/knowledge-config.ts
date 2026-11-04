import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createHandoffTrigger,
  createQualificationQuestion,
  deleteHandoffTrigger,
  deleteQualificationQuestion,
  listConfigRevisions,
  listHandoffTriggers,
  listQualificationQuestions,
  revertConfigRevision,
  updateHandoffTrigger,
  updateQualificationQuestion,
} from '../../../modules/knowledge/config-service.js';
import type { TrainDeps } from '../../../modules/knowledge/train-service.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const entityTypeSchema = z.enum(['qualification_question', 'handoff_trigger']);
const questionBody = z.object({
  lineSlug: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/),
  question: z.string().min(1).max(4000),
  answerType: z.enum(['text', 'number', 'choice']).default('text'),
  choices: z.array(z.string().min(1)).min(1).max(50).optional(),
  required: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
}).strict();
const questionPatch = z.object({
  question: z.string().min(1).max(4000).optional(),
  answerType: z.enum(['text', 'number', 'choice']).optional(),
  choices: z.array(z.string().min(1)).min(1).max(50).optional().nullable(),
  required: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
}).strict();
const triggerBody = z.object({
  lineSlug: z.string().min(1).nullable().optional(),
  code: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/),
  description: z.string().min(1).max(300),
  detectionHint: z.string().min(1).max(2000),
  action: z.enum(['handoff_now', 'handoff_when_qualified', 'flag_only']).default('handoff_now'),
  priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
  active: z.boolean().optional(),
}).strict();
const triggerPatch = z.object({
  description: z.string().min(1).max(300).optional(),
  detectionHint: z.string().min(1).max(2000).optional(),
  action: z.enum(['handoff_now', 'handoff_when_qualified', 'flag_only']).optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  active: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
}).strict();
const listQuery = z.object({ lineSlug: z.string().min(1).nullable().optional(), includeInactive: z.coerce.boolean().default(false) }).strict();
const revisionListQuery = z.object({ entityType: entityTypeSchema, entityId: z.uuid() }).strict();
const revertBody = z.object({ expectedVersion: z.number().int().min(1) }).strict();

export async function knowledgeConfigRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const knowledge = deps.knowledge!;
  const guard = [authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }), requireTenant(), requireAnyRole('editor', 'admin')];
  const scope = (r: FastifyRequest): TenantScope => ({ tenantId: r.auth!.tenantId! });
  const mk = (r: FastifyRequest): TrainDeps => ({ db: knowledge.db, scope: scope(r), audit: knowledge.audit, now: knowledge.now });

  app.get('/v1/knowledge/qualification-questions', { preHandler: guard }, async (request, reply) => {
    const query = listQuery.parse(request.query);
    return reply.send({ items: await listQualificationQuestions(mk(request), query) });
  });
  app.post('/v1/knowledge/qualification-questions', { preHandler: guard }, async (request, reply) => {
    const body = questionBody.parse(request.body);
    return reply.code(201).send(await createQualificationQuestion(mk(request), body, request.auth!.userId));
  });
  app.patch('/v1/knowledge/qualification-questions/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return reply.send(await updateQualificationQuestion(mk(request), id, questionPatch.parse(request.body), request.auth!.userId));
  });
  app.delete('/v1/knowledge/qualification-questions/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict().parse(request.query);
    await deleteQualificationQuestion(mk(request), id, query.expectedVersion, request.auth!.userId);
    return reply.code(204).send();
  });

  app.get('/v1/knowledge/triggers', { preHandler: guard }, async (request, reply) => {
    const query = listQuery.parse(request.query);
    return reply.send({ items: await listHandoffTriggers(mk(request), query) });
  });
  app.post('/v1/knowledge/triggers', { preHandler: guard }, async (request, reply) => {
    const body = triggerBody.parse(request.body);
    return reply.code(201).send(await createHandoffTrigger(mk(request), body, request.auth!.userId));
  });
  app.patch('/v1/knowledge/triggers/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return reply.send(await updateHandoffTrigger(mk(request), id, triggerPatch.parse(request.body), request.auth!.userId));
  });
  app.delete('/v1/knowledge/triggers/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict().parse(request.query);
    await deleteHandoffTrigger(mk(request), id, query.expectedVersion, request.auth!.userId);
    return reply.code(204).send();
  });

  app.get('/v1/knowledge/config-revisions', { preHandler: guard }, async (request, reply) => {
    const query = revisionListQuery.parse(request.query);
    return reply.send({ items: await listConfigRevisions(mk(request), query.entityType, query.entityId) });
  });
  app.post('/v1/knowledge/config-revisions/:revisionId/revert', { preHandler: guard }, async (request, reply) => {
    const { revisionId } = z.object({ revisionId: z.uuid() }).parse(request.params);
    const body = revertBody.parse(request.body);
    return reply.send(await revertConfigRevision(mk(request), revisionId, body.expectedVersion, request.auth!.userId));
  });

}
