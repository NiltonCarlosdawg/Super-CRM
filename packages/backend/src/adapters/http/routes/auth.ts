// Rotas de auth (Task 9): login/logout/me/password/totp. Cookies de sessão
// HttpOnly + SameSite=Lax (docs/03); cookie 'csrf' legível por JS; CSRF em
// todas as mutações (guard global). Mapeamento de LoginResult → HTTP.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HttpDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { authenticate } from '../guards.js';

const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'código TOTP de 6 dígitos') });

function cookieBase(deps: HttpDeps) {
  return {
    path: '/',
    sameSite: 'lax' as const,
    secure: deps.cfg.nodeEnv === 'production',
  };
}

function setSessionCookie(deps: HttpDeps, reply: FastifyReply, sessionId: string, expires: Date): void {
  reply.setCookie('session', sessionId, { ...cookieBase(deps), httpOnly: true, expires });
}

function setCsrfCookie(deps: HttpDeps, reply: FastifyReply, token: string, expires: Date): void {
  // legível por JS (é para o cliente ecoar no header x-csrf-token)
  reply.setCookie('csrf', token, { ...cookieBase(deps), expires });
}

export async function authRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const auth = authenticate({ sessions: deps.sessions });

  // Login: isento de CSRF (não existe sessão ainda); rate limit próprio.
  app.post(
    '/v1/auth/login',
    {
      config: {
        rateLimit: { max: deps.cfg.auth.loginRateMax, timeWindow: deps.cfg.auth.loginRateWindowMs },
      },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const result = await deps.login.login({
        email: body.email,
        password: body.password,
        ip: request.ip,
      });
      if (result.status === 'invalid_credentials') {
        throw new HttpError(401, 'invalid_credentials');
      }
      if (result.status === 'rate_limited') {
        throw new HttpError(
          429,
          'rate_limited',
          `login temporariamente bloqueado: tente em ${result.retryAfterSeconds}s`,
          { 'Retry-After': String(result.retryAfterSeconds) },
        );
      }
      const expires = new Date(result.expiresAt);
      setSessionCookie(deps, reply, result.sessionId, expires);
      const csrf = randomUUID();
      setCsrfCookie(deps, reply, csrf, expires);
      if (result.status === 'mfa_setup_required') {
        return reply.send({ mfa: 'setup', otpauthUrl: result.otpauthUrl, expiresAt: expires.toISOString() });
      }
      if (result.status === 'mfa_required') {
        return reply.send({ mfa: 'required', expiresAt: expires.toISOString() });
      }
      return reply.send({ user: result.user, expiresAt: expires.toISOString() });
    },
  );

  // Logout: 204, revoga a sessão se existir e apaga os cookies.
  app.post('/v1/auth/logout', async (request, reply) => {
    const sid = request.cookies.session;
    if (sid !== undefined) await deps.login.logout(sid);
    void reply.clearCookie('session', { path: '/' });
    void reply.clearCookie('csrf', { path: '/' });
    return reply.status(204).send();
  });

  // Quem sou eu: papel completo para o cliente; garante cookie csrf se ausente.
  app.get('/v1/auth/me', { preHandler: [auth] }, async (request, reply) => {
    const authCtx = request.auth!;
    const user = deps.users !== undefined ? await deps.users.findById(authCtx.userId) : null;
    if (user === null) throw new HttpError(401, 'unauthenticated');
    if (request.cookies.csrf === undefined) {
      setCsrfCookie(deps, reply, randomUUID(), new Date(Date.now() + 3_600_000));
    }
    return reply.send({ id: user.id, name: user.name, email: user.email, role: user.role });
  });

  // Mudança de palavra-passe: revoga as outras sessões e audita.
  app.post('/v1/auth/password', { preHandler: [auth] }, async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    const authCtx = request.auth!;
    await deps.login.changePassword({
      sessionId: authCtx.sessionId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ip: request.ip,
    });
    return reply.status(204).send();
  });

  // Setup TOTP: pendente de TOTP pode chamá-lo (allowlist do guard); idempotente.
  app.post('/v1/auth/totp/setup', { preHandler: [auth] }, async (request, reply) => {
    const authCtx = request.auth!;
    const user = deps.users !== undefined ? await deps.users.findById(authCtx.userId) : null;
    if (user === null) throw new HttpError(401, 'unauthenticated');
    const { otpauthUrl } = await deps.mfa.startSetup({
      userId: authCtx.userId,
      email: user.email,
      now: new Date(),
    });
    return reply.send({ otpauthUrl });
  });

  // Verificação TOTP: sucesso ⇒ sessão não-pendente (audit feito pelo MfaService).
  app.post(
    '/v1/auth/totp/verify',
    {
      preHandler: [auth],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const body = codeSchema.parse(request.body);
      const authCtx = request.auth!;
      const ok = await deps.mfa.verifyAndFinish({
        sessionId: authCtx.sessionId,
        userId: authCtx.userId,
        code: body.code,
        now: new Date(),
      });
      if (!ok) throw new HttpError(400, 'invalid_code', 'código TOTP inválido');
      return reply.send({ ok: true });
    },
  );
}
