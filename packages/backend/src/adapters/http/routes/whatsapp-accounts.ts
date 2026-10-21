// API de contas WhatsApp (Task 16): só admin, sessão + CSRF, zod por método.
// A sessão no WA-AKG nasce AQUI (provider.createSession) e o QR/estado vêm do
// provider — o servidor nunca decide permissões nem inventa sessões (docs/04 §6).
// `suspected_ban` NÃO tem rota de reset nesta fase (docs/04 §6, gate humano).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantScope } from '../../../ports/tenancy.js';
import type { HttpDeps } from '../app.js';
import { authenticate, requireRole, requireTenant } from '../guards.js';
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
  // Onda 1 (Task 4): rota de tenant SEMPRE opera no tenant da sessão —
  // `requireRole('admin')` exclui platform_admin (sem tenant) destas rotas e
  // `requireTenant` (Task 7, ruling R2/R15) recusa a plataforma ANTES de o
  // scope ser construído (a matriz T8 exige 403, nunca uma query sem âmbito).
  const adminOnly = [
    authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy }),
    requireRole('admin'),
    requireTenant(),
  ];
  const audit = deps.audit;

  // Onda 1 (Task 4): rota de tenant SEMPRE opera no tenant da sessão.
  // Hardening (review da Task 4, levado na Task 7): `tenantId` null rebenta
  // AQUI, alto — nunca uma query silenciosa sem âmbito (`requireTenant`
  // torna este caminho inalcançável; o throw é a rede para o futuro).
  const scope = (request: { auth?: { tenantId: string | null } }): TenantScope => {
    const tenantId = request.auth?.tenantId ?? null;
    if (tenantId === null) {
      throw new Error('scope de tenant ausente: rota de tenant alcançada sem requireTenant?');
    }
    return { tenantId };
  };

  app.post('/v1/whatsapp-accounts', { preHandler: adminOnly }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const now = deps.now();
    const s = scope(request);
    // A sessão nasce no provider PRIMEIRO (sem linha órfã na BD se falhar).
    const { sessionId } = await provider.createSession({ label: body.label });
    const { id } = await accounts.create(s, {
      label: body.label,
      purpose: body.purpose,
      providerSessionId: sessionId,
      now,
    });
    await audit.record({
      tenantId: s.tenantId,
      actorId: request.auth?.userId ?? null,
      action: 'account.created',
      entity: 'whatsapp_account',
      entityId: id,
      detail: { purpose: body.purpose },
      at: now,
      ip: request.ip,
    });
    return reply.status(201).send({ account: await accounts.get(s, id) });
  });

  app.get('/v1/whatsapp-accounts', { preHandler: adminOnly }, async (request) => ({
    accounts: await accounts.list(scope(request)),
  }));

  app.get('/v1/whatsapp-accounts/:id', { preHandler: adminOnly }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const s = scope(request);
    const account = await accounts.get(s, id);
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
    const s = scope(request);
    const account = await accounts.get(s, id);
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
    const changed = await accounts.setStatus(s, id, 'disconnected', now);
    await accounts.setPhone(s, id, null); // logout limpa o telefone (docs/04 §6)
    await audit.record({
      tenantId: s.tenantId,
      actorId: request.auth?.userId ?? null,
      action: 'account.logout',
      entity: 'whatsapp_account',
      entityId: id,
      at: now,
      ip: request.ip,
    });
    if (changed) {
      // R31: rota de tenant — o scope da sessão traz o tenant (requireTenant).
      await notify({ type: 'account', tenantId: s.tenantId, accountId: id, status: 'disconnected' });
    }
    return reply.send({ account: await accounts.get(s, id) });
  });
}
