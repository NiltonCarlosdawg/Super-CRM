// API de conversas e mensagens (Task 21): qualquer papel autenticado lê e
// envia (requireRole nenhum); sessão obrigatória e CSRF global nas mutações.
// Idempotency-Key é OBRIGATÓRIO no envio — a outbox é a única saída (docs/04 §7).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../../../domain/error.js';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate } from '../guards.js';

const idSchema = z.object({ id: z.uuid() });

const listQuery = z.object({
  accountId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const messagesQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sendSchema = z.object({ text: z.string() });

export async function conversationsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const repo = deps.conversations;
  const sender = deps.messageSender;
  if (repo === undefined || sender === undefined) return;
  const anyRole = [authenticate({ sessions: deps.sessions })];

  app.get('/v1/conversations', { preHandler: anyRole }, async (request, reply) => {
    const q = listQuery.parse(request.query);
    const page = await repo.list({ accountId: q.accountId, cursor: q.cursor, limit: q.limit });
    return reply.send({ conversations: page.items, nextCursor: page.nextCursor });
  });

  app.get('/v1/conversations/:id', { preHandler: anyRole }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const found = await repo.get(id);
    if (found === null) throw new DomainError('not_found');
    return reply.send({ conversation: found.conversation, lastMessage: found.lastMessage });
  });

  app.get('/v1/conversations/:id/messages', { preHandler: anyRole }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const q = messagesQuery.parse(request.query);
    const page = await repo.listMessages({ conversationId: id, cursor: q.cursor, limit: q.limit });
    return reply.send({ messages: page.items, nextCursor: page.nextCursor });
  });

  app.post('/v1/conversations/:id/messages', { preHandler: anyRole }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = sendSchema.parse(request.body);
    const rawKey = request.headers['idempotency-key'];
    const key = typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim() : undefined;
    if (key === undefined) {
      throw new HttpError(400, 'validation_failed', "header 'Idempotency-Key' obrigatório (identificador único do envio)");
    }
    const result = await sender.sendHumanMessage({
      conversationId: id,
      text: body.text,
      idempotencyKey: key,
      actorId: request.auth!.userId,
      ip: request.ip,
    });
    if ('conflict' in result) {
      throw new HttpError(409, 'idempotency_conflict', "header 'Idempotency-Key' reutilizado com um corpo diferente");
    }
    return reply.status(result.replayed ? 200 : 201).send(result);
  });
}
