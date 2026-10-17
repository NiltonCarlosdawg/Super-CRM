// Guards de autenticação, CSRF e papel (Task 9). A sessão vem do cookie e é
// validada contra o SessionStore (server-side, A2); o contexto fica em
// `request.auth` para as rotas consumirem.
//
// Onda 1, Task 3: o `request.auth` resolve o âmbito POR PEDIDO — papel,
// estado e tenant vêm da linha `users` (autoridade), nunca do snapshot da
// sessão; tenant suspenso → 403 tenant_suspended (spec multitenant §4.3).

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import type { AuthUserRepo, Role, SessionRecord, SessionStore } from '../../ports/auth.js';
import type { TenancyPort } from '../../ports/tenancy.js';
import { HttpError } from './errors.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  role: Role;
  /** Tenant do utilizador (null só para platform_admin, garantido pelo CHECK de users). */
  tenantId: string | null;
  /** platform_admin: administra a plataforma, não pertence a nenhum tenant. */
  isPlatform: boolean;
  mfaPending: boolean;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const route = (request: FastifyRequest): string =>
  `${request.method} ${request.url.split('?')[0] ?? ''}`;

// Rotas permitidas com sessão mfaPending (Task 8: terminar o setup/verify e poder sair).
const MFA_ALLOWLIST = new Set([
  'POST /v1/auth/totp/setup',
  'POST /v1/auth/totp/verify',
  'POST /v1/auth/logout',
]);

/** Lê o cookie 'session', valida contra o SessionStore e popula request.auth. */
export function authenticate(deps: {
  sessions: SessionStore;
  users: AuthUserRepo;
  tenancy: TenancyPort;
}): preHandlerHookHandler {
  return async (request) => {
    const sid = request.cookies.session;
    const session: SessionRecord | null = sid ? await deps.sessions.get(sid, new Date()) : null;
    if (session === null) throw new HttpError(401, 'unauthenticated');
    if (session.mfaPending && !MFA_ALLOWLIST.has(route(request))) {
      throw new HttpError(403, 'mfa_required');
    }
    // Autoridade por pedido: a linha `users` manda (papel, estado, tenant);
    // `session.role` é snapshot de criação e não autoriza nada (Task 3).
    const user = await deps.users.findById(session.userId);
    if (user === null || !user.active) throw new HttpError(401, 'unauthenticated');
    const isPlatform = user.role === 'platform_admin';
    if (user.tenantId !== null) {
      const status = await deps.tenancy.getStatus(user.tenantId);
      if (status === 'suspended') throw new HttpError(403, 'tenant_suspended');
    }
    request.auth = {
      sessionId: session.sessionId,
      userId: user.id,
      role: user.role,
      tenantId: user.tenantId,
      isPlatform,
      mfaPending: session.mfaPending,
      ip: request.ip,
    };
  };
}

/** Papel exigido; corre DEPOIS do authenticate. */
export function requireRole(role: Role): preHandlerHookHandler {
  return async (request) => {
    const auth = request.auth;
    if (auth === undefined) throw new HttpError(401, 'unauthenticated');
    if (auth.role !== role) {
      throw new HttpError(403, 'forbidden', `papel '${auth.role}' insuficiente: é necessário '${role}'`);
    }
  };
}

/**
 * Onda 1, Task 7 (ruling R2/R15): preHandler de TODA rota de tenant — uma
 * sessão de plataforma (tenantId null) é recusada aqui em vez de construir um
 * scope silencioso sem âmbito (o `tenantId!` dos helpers de rota seria um
 * type-lie; o hardening desses helpers faz throw, mas este guard é o contrato).
 */
export function requireTenant(): preHandlerHookHandler {
  return async (request) => {
    const auth = request.auth;
    if (auth === undefined) throw new HttpError(401, 'unauthenticated');
    if (auth.isPlatform) {
      throw new HttpError(403, 'forbidden', 'rota de tenant não aceita sessão de plataforma');
    }
  };
}

/**
 * Onda 1, Task 7 (spec multitenant §5.3): preHandler de TODA rota
 * `/v1/platform/*`. As rotas de plataforma ficam FORA do MFA_ALLOWLIST — uma
 * sessão mfaPending é recusada pelo `authenticate` (403 mfa_required) ANTES
 * deste guard correr.
 */
export function requirePlatform(): preHandlerHookHandler {
  return async (request) => {
    const auth = request.auth;
    if (auth === undefined) throw new HttpError(401, 'unauthenticated');
    if (!auth.isPlatform) {
      throw new HttpError(403, 'forbidden', "rota de plataforma: é necessário o papel 'platform_admin'");
    }
  };
}

/**
 * CSRF por cookie (docs/03): mutações autenticadas por cookie exigem o header
 * 'x-csrf-token' igual ao cookie 'csrf' (comparação em tempo constante).
 * Sem cookie de sessão não há nada a proteger — o authenticate responde 401.
 */
export function csrfGuard(): onRequestHookHandler {
  return async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    if (request.cookies.session === undefined) return;
    const token = request.headers['x-csrf-token'];
    const a = Buffer.from(typeof token === 'string' ? token : '', 'utf8');
    const b = Buffer.from(request.cookies.csrf ?? '', 'utf8');
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(403, 'csrf_invalid', "header 'x-csrf-token' ausente ou diferente do cookie 'csrf'");
    }
  };
}
