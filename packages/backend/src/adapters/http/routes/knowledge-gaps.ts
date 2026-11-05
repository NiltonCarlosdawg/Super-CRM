import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createSuggestion, decideGap, decideSuggestion, listGaps, listSuggestions } from '../../../modules/knowledge/gaps-service.js';
import type { TrainDeps } from '../../../modules/knowledge/train-service.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireAnyRole, requireTenant } from '../guards.js';

const id = z.object({ id: z.uuid() });
const query = z.object({ status: z.enum(['open', 'resolved', 'ignored', 'pending', 'approved', 'rejected']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const suggestionBody = z.object({ humanAnswer: z.string().min(1).max(4000), proposedTitle: z.string().min(1).max(200), proposedBody: z.string().min(1).max(20000), aiAnswer: z.string().max(4000).optional(), targetDocId: z.uuid().nullable().optional(), proposedLineSlug: z.string().nullable().optional(), proposedDocType: z.enum(['faq', 'policy', 'process', 'company_info', 'objection']).optional(), conversationId: z.uuid().nullable().optional(), messageId: z.uuid().nullable().optional(), gapId: z.uuid().nullable().optional() }).strict();

export async function knowledgeGapsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const k = deps.knowledge!;
  const guard = [authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }), requireTenant(), requireAnyRole('editor', 'admin')];
  const mk = (r: FastifyRequest): TrainDeps => ({ db: k.db, scope: { tenantId: r.auth!.tenantId! }, audit: k.audit, now: k.now });
  app.get('/v1/knowledge/gaps', { preHandler: guard }, async (r, reply) => { const q = query.parse(r.query); return reply.send({ items: await listGaps(mk(r), (q.status as 'open' | 'resolved' | 'ignored') ?? 'open', q.limit) }); });
  app.post('/v1/knowledge/gaps/:id/resolve', { preHandler: guard }, async (r, reply) => { const p = id.parse(r.params); return reply.send(await decideGap(mk(r), p.id, 'resolved', r.auth!.userId)); });
  app.post('/v1/knowledge/gaps/:id/ignore', { preHandler: guard }, async (r, reply) => { const p = id.parse(r.params); return reply.send(await decideGap(mk(r), p.id, 'ignored', r.auth!.userId)); });

  app.get('/v1/knowledge/suggestions', { preHandler: guard }, async (r, reply) => { const q = query.parse(r.query); return reply.send({ items: await listSuggestions(mk(r), q.status as 'pending' | 'approved' | 'rejected' | undefined, q.limit) }); });
  app.post('/v1/knowledge/suggestions', { preHandler: guard }, async (r, reply) => reply.code(201).send(await createSuggestion(mk(r), suggestionBody.parse(r.body), r.auth!.userId)));
  app.post('/v1/knowledge/suggestions/:id/approve', { preHandler: guard }, async (r, reply) => { const p = id.parse(r.params); return reply.send(await decideSuggestion(mk(r), p.id, 'approved', r.auth!.userId)); });
  app.post('/v1/knowledge/suggestions/:id/reject', { preHandler: guard }, async (r, reply) => { const p = id.parse(r.params); return reply.send(await decideSuggestion(mk(r), p.id, 'rejected', r.auth!.userId)); });
}
