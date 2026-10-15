// API de contas WhatsApp (Task 16): só admin, sessão + CSRF, zod por método.
// A sessão no WA-AKG nasce AQUI (provider.createSession) e o QR/estado vêm do
// provider — o servidor nunca decide permissões nem inventa sessões (docs/04 §6).
// `suspected_ban` NÃO tem rota de reset nesta fase (docs/04 §6, gate humano).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpDeps } from '../app.js';
import { authenticate, requireRole } from '../guards.js';
import { HttpError } from '../errors.js';
import { ProviderUnavailableError } from '../../../ports/messaging-provider.js';

const createSchema = z.object({
  label: z.string().min(1),
  purpose: z.enum(['support', 'sales', 'campaigns']),
});

const idSchema = z.object({ id: z.uuid() });

export async function whatsappAccountsRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const accounts = deps.accounts;
  const provider = deps.waProvider;
  if (accounts === undefined || provider === undefined) return;

  const notify = deps.notifySink ?? (async () => {});
  const adminOnly = [authenticate({ sessions: deps.sessions }), requireRole('admin')];
  const audit = deps.audit;

  app.post('/v1/whatsapp-accounts', { preHandler: adminOnly }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const now = deps.now();
    // A sessão nasce no provider PRIMEIRO (sem linha órfã na BD se falhar).
    const { sessionId } = await provider.createSession({ label: body.label });
    const { id } = await accounts.create({
      label: body.label,
      purpose: body.purpose,
      providerSessionId: sessionId,
      now,
    });
    await audit.record({
      actorId: request.auth?.userId ?? null,
      action: 'account.created',
      entity: 'whatsapp_account',
      entityId: id,
      detail: { purpose: body.purpose },
      at: now,
      ip: request.ip,
    });
    return reply.status(201).send({ account: await accounts.get(id) });
  });

  app.get('/v1/whatsapp-accounts', { preHandler: adminOnly }, async () => ({
    accounts: await accounts.list(),
  }));

  app.get('/v1/whatsapp-accounts/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const account = await accounts.get(id);
    if (account === null) {
      throw new HttpError(404, 'account_not_found', 'conta WhatsApp não encontrada');
    }
    if (account.status !== 'connecting') return { account };
    // QR do provider falso/real enquanto conecta (a sessão vive no WA-AKG)
    const qr = await provider.getQr(account.providerSessionId);
    return qr === null ? { account } : { account, qr: qr.qr };
  });

  app.post('/v1/whatsapp-accounts/:id/logout', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const account = await accounts.get(id);
    if (account === null) {
      throw new HttpError(404, 'account_not_found', 'conta WhatsApp não encontrada');
    }
    try {
      await provider.logout(account.providerSessionId);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new HttpError(503, 'provider_unavailable', 'WA-AKG indisponível: tente novamente');
      }
      throw error;
    }
    const now = deps.now();
    const changed = await accounts.setStatus(id, 'disconnected', now);
    await accounts.setPhone(id, null); // logout limpa o telefone (docs/04 §6)
    await audit.record({
      actorId: request.auth?.userId ?? null,
      action: 'account.logout',
      entity: 'whatsapp_account',
      entityId: id,
      at: now,
      ip: request.ip,
    });
    if (changed) await notify({ type: 'account', accountId: id, status: 'disconnected' });
    return reply.send({ account: await accounts.get(id) });
  });
}
