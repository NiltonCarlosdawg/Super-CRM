// API de utilizadores (Task 10): só admin, sessão + CSRF, zod por método.
// Guardas: auto-mutação de role/active → 403 cannot_modify_self; último admin
// ativo → 409 last_admin; password revoga as sessões do alvo; auditoria de
// todas as operações (docs/03: sem passwords em detalhes).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../../../domain/error.js';
import { assertPasswordPolicy } from '../../../domain/password.js';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireRole } from '../guards.js';

const createSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  role: z.enum(['agent', 'editor', 'admin']),
  password: z.string().min(1),
});

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(['agent', 'editor', 'admin']).optional(),
    active: z.boolean().optional(),
    password: z.string().min(1).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'patch sem campos' });

const idSchema = z.object({ id: z.uuid() });

export async function usersRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const repo = deps.usersRepo;
  const audit = deps.audit;
  const hasher = deps.hasher;
  const adminOnly = [authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }), requireRole('admin')];

  // Onda 1 (Task 4): rota de tenant SEMPRE opera no tenant da sessão —
  // `requireRole('admin')` exclui platform_admin (sem tenant) destas rotas.
  const scope = (request: { auth?: { tenantId: string | null } }): TenantScope => ({
    tenantId: request.auth!.tenantId!,
  });

  app.post('/v1/users', { preHandler: adminOnly }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    assertPasswordPolicy(body.password);
    const now = deps.now();
    const s = scope(request);
    const passwordHash = await hasher.hash(body.password);
    const user = await repo.create(s, {
      name: body.name.trim(),
      email: body.email,
      role: body.role,
      passwordHash,
      now,
    });
    await audit.record({
      tenantId: s.tenantId,
      actorId: request.auth!.userId,
      action: 'user.created',
      entity: 'user',
      entityId: user.id,
      detail: { email: user.email, role: user.role },
      at: now,
      ip: request.ip,
    });
    return reply.status(201).send({ user });
  });

  app.get('/v1/users', { preHandler: adminOnly }, async (request, reply) =>
    reply.send({ users: await repo.list(scope(request)) }),
  );

  app.patch('/v1/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = patchSchema.parse(request.body);
    const now = deps.now();
    const s = scope(request);
    const actorId = request.auth!.userId;

    // Utilizador de OUTRO tenant → null → 404 (cross-tenant esconde existência).
    const target = await repo.findById(s, id);
    if (target === null) throw new DomainError('user_not_found');

    // auto-mutação de papel/estado: proibida (docs/01 §5)
    if (id === actorId && (body.role !== undefined || body.active !== undefined)) {
      throw new DomainError('cannot_modify_self');
    }

    // guarda do último admin ativo (defesa em profundidade)
    const demotesAdmin =
      target.role === 'admin' &&
      target.active &&
      ((body.role !== undefined && body.role !== 'admin') || body.active === false);
    if (demotesAdmin && (await repo.countActiveAdmins(s, id)) === 0) {
      throw new DomainError('last_admin');
    }

    const passwordHash = body.password !== undefined ? await policyHash(body.password) : undefined;
    const ok = await repo.update(
      s,
      id,
      { name: body.name?.trim(), role: body.role, active: body.active, passwordHash },
      now,
    );
    if (!ok) throw new DomainError('user_not_found');

    // qualquer mudança sensível revoga as sessões do alvo (docs/01 §5)
    if (body.role !== undefined || body.active !== undefined || body.password !== undefined) {
      await deps.sessions.revokeAllForUser(id);
    }

    const record = (action: string, detail: Record<string, unknown>): Promise<void> =>
      audit.record({ tenantId: s.tenantId, actorId, action, entity: 'user', entityId: id, detail, at: now, ip: request.ip });
    await record('user.updated', { fields: Object.keys(body) });
    if (body.role !== undefined && body.role !== target.role) {
      await record('user.role_changed', { from: target.role, to: body.role });
    }
    if (body.active === false && target.active) await record('user.deactivated', {});
    if (body.password !== undefined) await record('user.password_reset', {});

    const user = await repo.findById(s, id);
    if (user === null) throw new DomainError('user_not_found');
    return reply.send({ user });
  });

  /** valida a política ANTES de hashear (erros 400 sem gastar argon2). */
  async function policyHash(plain: string): Promise<string> {
    assertPasswordPolicy(plain);
    return hasher.hash(plain);
  }
}
