// Guards de autenticação, CSRF e papel (Task 9). A sessão vem do cookie e é
// validada contra o SessionStore (server-side, A2); o contexto fica em
// `request.auth` para as rotas consumirem.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import type { Role, SessionRecord, SessionStore } from '../../ports/auth.js';
import { HttpError } from './errors.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  role: Role;
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
export function authenticate(deps: { sessions: SessionStore }): preHandlerHookHandler {
  return async (request) => {
    const sid = request.cookies.session;
    const session: SessionRecord | null = sid ? await deps.sessions.get(sid, new Date()) : null;
    if (session === null) throw new HttpError(401, 'unauthenticated');
    if (session.mfaPending && !MFA_ALLOWLIST.has(route(request))) {
      throw new HttpError(403, 'mfa_required');
    }
    request.auth = {
      sessionId: session.sessionId,
      userId: session.userId,
      role: session.role,
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
