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
import type { AIConfig } from '../ai/config.js';
import type { Audit } from '../../ports/audit.js';
import type { AuthUserRepo, MfaPort, SessionStore } from '../../ports/auth.js';
import type { PasswordHasher } from '../../ports/security.js';
import type { TenancyPort } from '../../ports/tenancy.js';
import type { DbClient } from '../db/index.js';
import type { TenantsRepository } from '../db/tenants.js';
import type { UsersRepository } from '../db/users.js';
import { toProblem } from './errors.js';
import { authenticate, csrfGuard } from './guards.js';
import { authRoutes } from './routes/auth.js';
import { conversationsRoutes } from './routes/conversations.js';
import { draftsRoutes } from './routes/drafts.js';
import { handoffsRoutes } from './routes/handoffs.js';
import { knowledgeTrainRoutes } from './routes/knowledge-train.js';
import { platformRoutes } from './routes/platform.js';
import { usersRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhook.js';
import { whatsappAccountsRoutes } from './routes/whatsapp-accounts.js';
import type { createLoginService } from '../../application/auth/login.js';
import type { HandoffConversations } from '../../application/handoffs.js';
import type { Settings } from '../../modules/settings/settings.js';
import type { AccountsRepository } from '../../ports/accounts.js';
import type { AIProvider, Ports } from '../../ports/ai-provider.js';
import type { ConversationsRepository } from '../../ports/conversations.js';
import type { EmbeddingsProvider } from '../../ports/embeddings.js';
import type { HandoffQueueRepository } from '../../ports/handoff-queue.js';
import type { JobQueue } from '../../ports/job-queue.js';
import type { MessagingProvider } from '../../ports/messaging-provider.js';
import type { NotifyEvent } from '../../ports/notify.js';
import type { Outbox } from '../../ports/outbox.js';
import type { MessageSender } from '../../application/messaging.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Bytes originais do corpo JSON, sem re-serializar (webhooks WA-AKG). */
    rawBody?: Buffer;
  }
}

export interface HttpDeps {
  cfg: { nodeEnv: NodeEnv; auth: AuthConfig };
  db?: DbClient;
  users: AuthUserRepo; // guard de auth (papel/tenant por pedido) + /v1/auth/me
  usersRepo: UsersRepository; // API de utilizadores (Task 10)
  /** Onda 1, Task 7: superfície /v1/platform/* — lista, ciclo de vida e drill. */
  tenantsRepo: TenantsRepository;
  audit: Audit;
  hasher: PasswordHasher;
  sessions: SessionStore;
  /** Onda 1, Task 3: estado do tenant para o guard (suspensão → 403). */
  tenancy: TenancyPort;
  login: ReturnType<typeof createLoginService>;
  mfa: MfaPort;
  logger: Logger;
  now(): Date; // relógio injetado (docs/02 §3)
  /** Task 16: contas WhatsApp — as rotas admin só registam com os dois presentes. */
  accounts?: AccountsRepository;
  waProvider?: MessagingProvider;
  /** Task 20: fila para o ingest de webhook enfileirar `inbound.process`. */
  jobs?: JobQueue;
  /** Task 21: leitura de conversas + envio humano (qualquer papel autenticado). */
  conversations?: ConversationsRepository;
  messageSender?: MessageSender;
  /** Fase 3 (Task 18): a aprovação de rascunhos enfileira na outbox (única saída). */
  outbox?: Outbox;
  /** Fase 3 (Task 14): fila de handoffs — claim/resolução/devolução à IA. */
  handoffs?: {
    queue: HandoffQueueRepository;
    conversations: HandoffConversations;
    settings: Settings;
    notify: Ports['notify'];
  };
  /**
   * Treinar agente (Task 4): upload → extração → rascunho. Só com o bundle
   * montado as rotas `/v1/knowledge/train/*` são registadas. `aiCfg`/`settings`
   * servem as tarefas seguintes (chat de teste); aqui só se transportam.
   */
  knowledge?: {
    db: DbClient;
    provider: AIProvider;
    aiCfg: AIConfig;
    settings: Settings;
    jobs: JobQueue;
    embedder?: EmbeddingsProvider;
    audit: Audit;
    now(): Date;
  };
  /** Sinks de evento (realtime Task 15); o logout de admin notifica a transição. */
  notifySink?: (e: NotifyEvent) => Promise<void>;
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
  app.get('/v1/openapi.json', { preHandler: [authenticate({ sessions: deps.sessions, users: deps.users, tenancy: deps.tenancy })] }, async () =>
    app.swagger(),
  );

  void app.register(
    async (instance) => {
      await authRoutes(instance, deps);
      await usersRoutes(instance, deps);
      // Task 16: só com repo + provider monta as rotas de contas (padrão `db?`).
      if (deps.accounts !== undefined && deps.waProvider !== undefined) {
        await whatsappAccountsRoutes(instance, deps);
      }
      // Task 20: webhook público do WA-AKG (sem sessão) — só com fila presente.
      if (deps.jobs !== undefined && deps.waProvider !== undefined && deps.db !== undefined) {
        await webhookRoutes(instance, deps);
      }
      // Task 21: conversas/mensagens — só com repo + sender monta as rotas.
      if (deps.conversations !== undefined && deps.messageSender !== undefined) {
        await conversationsRoutes(instance, deps);
      }
      // Fase 3 (Task 14): fila de handoffs — só com o bundle montado.
      if (deps.handoffs !== undefined) {
        await handoffsRoutes(instance, deps);
      }
      // Fase 3 (Task 18): rascunhos — a aprovação enfileira na outbox, logo
      // precisa de db (ler/atualizar) + outbox (enqueue).
      if (deps.outbox !== undefined && deps.db !== undefined) {
        await draftsRoutes(instance, deps);
      }
      // Treinar agente (Task 4): upload/extração/rascunho — só com o bundle.
      if (deps.knowledge !== undefined) {
        await knowledgeTrainRoutes(instance, deps);
      }
      // Task 7: superfície de plataforma (spec §5.3) — requirePlatform em todas.
      await platformRoutes(instance, deps);
    },
    { prefix: '' },
  );

  return app;
}
