// App HTTP (Task 9): Fastify + cookie + rate-limit global + erros RFC 9457 +
// raw body preservado (assinatura de webhook, docs/04 §5) + OpenAPI.
// Composição: quem monta as dependências é o main.ts (produção) ou o
// buildTestApp (testes) — aqui só se consomem ports.

import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NodeEnv } from '../../infra/config.js';
import type { AuthConfig } from '../../infra/config-app.js';
import type { Audit } from '../../ports/audit.js';
import type { AuthUserRepo, MfaPort, SessionStore } from '../../ports/auth.js';
import type { PasswordHasher } from '../../ports/security.js';
import type { DbClient } from '../db/index.js';
import type { UsersRepository } from '../db/users.js';
import { toProblem } from './errors.js';
import { authenticate, csrfGuard } from './guards.js';
import { authRoutes } from './routes/auth.js';
import { usersRoutes } from './routes/users.js';
import type { createLoginService } from '../../application/auth/login.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Bytes originais do corpo JSON, sem re-serializar (webhooks WA-AKG). */
    rawBody?: Buffer;
  }
}

export interface HttpDeps {
  cfg: { nodeEnv: NodeEnv; auth: AuthConfig };
  db?: DbClient;
  users?: AuthUserRepo; // /v1/auth/me devolve {id,name,email,role}
  usersRepo: UsersRepository; // API de utilizadores (Task 10)
  audit: Audit;
  hasher: PasswordHasher;
  sessions: SessionStore;
  login: ReturnType<typeof createLoginService>;
  mfa: MfaPort;
  logger: Logger;
  now(): Date; // relógio injetado (docs/02 §3)
  /** Checks de readiness adicionais (ex.: ping Redis no arranque real). */
  readyChecks?: Array<{ name: string; run: () => Promise<unknown> }>;
}

export function buildHttpApp(deps: HttpDeps): FastifyInstance {
  const app = Fastify({
    // cast: pino.Logger é compatível em runtime; o tipo do FastifyBaseLogger
    // mantém a instância com os generics por omissão.
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: deps.cfg.auth.bodyLimitBytes,
    genReqId: () => randomUUID(),
  });

  void app.register(fastifyCookie);
  void app.register(fastifyRateLimit, {
    max: deps.cfg.auth.httpRateMax,
    timeWindow: deps.cfg.auth.httpRateWindowMs,
  });
  void app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'MilVendas CRM', version: '1.0.0' },
    },
  });

  // JSON com raw body preservado: bytes originais em request.rawBody, parse manual.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    try {
      done(null, raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')));
    } catch {
      done(new Error('corpo JSON inválido'), undefined);
    }
  });

  app.addHook('onRequest', csrfGuard());

  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const { status, body } = toProblem(err, String(request.id));
    if (err instanceof Error && 'headers' in err && err.headers !== undefined) {
      for (const [k, v] of Object.entries(err.headers as Record<string, string>)) reply.header(k, v);
    }
    request.log.error({ err: { name: (err as Error)?.name, message: (err as Error)?.message }, status }, 'http.error');
    void reply.status(status).type('application/problem+json').send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send(toProblem(new Error('not_found'), String(request.id)).body);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      void p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e: unknown) => { clearTimeout(t); reject(e); },
      );
    });

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};
    const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await withTimeout(fn(), 2000);
        checks[name] = 'ok';
      } catch {
        checks[name] = 'failed';
      }
    };
    if (deps.db !== undefined) await run('db', () => deps.db!.execute(sql`select 1`));
    for (const c of deps.readyChecks ?? []) await run(c.name, c.run);
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  // OpenAPI: qualquer papel autenticado pode lê-lo (docs/01 §3: APIs com OpenAPI);
  // sem sessão → 401, sem requireRole.
  app.get('/v1/openapi.json', { preHandler: [authenticate({ sessions: deps.sessions })] }, async () =>
    app.swagger(),
  );

  void app.register(
    async (instance) => {
      await authRoutes(instance, deps);
      await usersRoutes(instance, deps);
    },
    { prefix: '' },
  );

  return app;
}
