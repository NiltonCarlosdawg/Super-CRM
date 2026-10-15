// Arranque da aplicação (Fase 1, Task 9): config validada → pool/pg, Redis e
// fila → auth real (argon2 + TOTP) → Fastify a escutar → graceful shutdown
// (SIGTERM/SIGINT: fecha realtime (Socket.IO) → server → fila → Redis → pool).

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { z } from 'zod';
import { buildHttpApp } from '../adapters/http/app.js';
import { createUnavailableAiProvider } from '../adapters/ai/unavailable.js';
import { createAccountsRepository } from '../adapters/db/accounts.js';
import { createAuditAdapter } from '../adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../adapters/db/auth.js';
import { createDb } from '../adapters/db/index.js';
import { createOrchestratorPorts } from '../adapters/db/orchestrator-ports.js';
import { createOutbox } from '../adapters/db/outbox.js';
import { createUsersRepository } from '../adapters/db/users.js';
import { createJobQueue } from '../adapters/queue/index.js';
import { attachRealtime, createSocketNotify, type RealtimeHandle } from '../adapters/realtime/socket.js';
import { createWaAkgAdapter } from '../adapters/wa-akg/index.js';
import { createAccountLifecycle } from '../application/account-lifecycle.js';
import { createLoginService } from '../application/auth/login.js';
import { createLoginLimiter } from '../application/auth/login-limiter.js';
import { createMfaService } from '../application/auth/mfa.js';
import { handleInboundEvent } from '../application/handle-inbound.js';
import { createInboundProcessHandler } from '../application/inbound-process.js';
import { advanceMessageStatus } from '../application/message-status.js';
import { handleInbound, type InboundMessage, type Outcome } from '../application/orchestrator.js';
import { runOutboxTick } from '../application/outbox-worker.js';
import { ConfigError } from './config.js';
import { loadFullConfig } from './config-app.js';
import { createLogger, withCorrelationId } from './logger.js';
import { createArgon2Hasher } from './security/argon2.js';
import { createTotp } from './security/totp.js';

async function main(): Promise<void> {
  const config = loadFullConfig(process.env);
  const log = withCorrelationId(createLogger({ level: config.logLevel }), randomUUID());

  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createDb(pool);
  const redis = new Redis(config.redisUrl);
  // Sem apanhador, um Redis inacessível rebentaria o processo (evento 'error').
  redis.on('error', (e: Error) => log.warn({ err: { message: e.message } }, 'redis.error'));
  const jobs = createJobQueue({ redisUrl: config.redisUrl });

  const hasher = createArgon2Hasher();
  const sessions = createSessionStore({ db });
  const users = createAuthUserRepo({ db, hasher });
  const audit = createAuditAdapter({ db });
  const now = (): Date => new Date();
  const mfa = createMfaService({ users, sessions, totp: createTotp(), cfg: config.auth, audit, now });
  const login = createLoginService({
    users,
    sessions,
    hasher,
    mfa,
    limiter: createLoginLimiter(
      {
        max: config.auth.loginRateMax,
        windowMs: config.auth.loginRateWindowMs,
        lockMaxMs: config.auth.loginLockMaxMs,
      },
      now,
    ),
    audit,
    cfg: config.auth,
    now,
  });

  // Task 15/16: o sink resolve o io NO MOMENTO DO EMIT — o Socket.IO só nasce
  // depois do Fastify (precisa do httpServer), mas as rotas já pedem o sink no
  // arranque. Wrapper {to,emit} sobre o handle, atribuído após o attach.
  const realtime: { handle?: RealtimeHandle } = {};
  const socketNotify = createSocketNotify(
    {
      to: (room) => ({
        emit: (event, payload) => {
          realtime.handle?.io.to(room).emit(event, payload);
        },
      }),
    },
    log,
  );

  const accountsRepo = createAccountsRepository({ db });
  // adaptador REAL do WA-AKG (docs/04 §1: só pelo adaptador MessagingProvider)
  const waProvider = createWaAkgAdapter({
    baseUrl: config.messaging.waAkgBaseUrl,
    apiKey: config.messaging.waAkgApiKey,
    webhookSecret: config.messaging.waWebhookSecret,
    sendTimeoutMs: config.messaging.sendTimeoutMs,
    cbThreshold: config.messaging.cbThreshold,
    cbCooldownMs: config.messaging.cbCooldownMs,
  });

  const app = buildHttpApp({
    cfg: config,
    db,
    users,
    usersRepo: createUsersRepository({ db }),
    audit,
    hasher,
    sessions,
    login,
    mfa,
    logger: log,
    now,
    accounts: accountsRepo,
    waProvider,
    jobs,
    notifySink: socketNotify,
    readyChecks: [{ name: 'redis', run: () => redis.ping() }],
  });

  // Task 15: Socket.IO no mesmo httpServer (handshake autenticado por sessão).
  realtime.handle = attachRealtime({ server: app.server, sessions, now });

  // Task 16/18: ciclo de vida partilhado (webhook de sessão + worker da outbox).
  const lifecycle = createAccountLifecycle({
    accounts: accountsRepo,
    provider: waProvider,
    notifySink: socketNotify,
    audit,
    cfg: { failWindow: config.messaging.failWindow, failRatio: config.messaging.failRatio },
    now,
    log,
  });

  // Task 19+20 (docs/05 §3.1): orquestrador de inbound SEM IA configurada —
  // `createUnavailableAiProvider` rejeita sempre → o orquestrador cai no
  // failSafe (ai_active: mensagem fixa + passa a humano; ai_suggest: rascunho
  // por aprovar, D13) — e o job 'inbound.process' que despacha por tipo.
  const orchestratorPorts = createOrchestratorPorts({
    db,
    notifySink: socketNotify,
    claimTtlMs: config.messaging.claimTtlMs,
    now,
  });
  const unavailableAiProvider = createUnavailableAiProvider();
  const orchestrate = (msg: InboundMessage): Promise<Outcome> =>
    handleInbound(orchestratorPorts, unavailableAiProvider, msg);
  const inboundOutbox = createOutbox({
    db,
    notifySink: socketNotify,
    now,
    random: Math.random,
    replyDelay: config.messaging.replyDelayMs,
  });
  await jobs.register(
    'inbound.process',
    createInboundProcessHandler({
      db,
      now,
      logger: log,
      runHandleInbound: (eventId) =>
        handleInboundEvent(
          {
            db,
            ports: orchestratorPorts,
            orchestrate,
            outbox: inboundOutbox,
            notifySink: socketNotify,
            cfg: { claimTtlMs: config.messaging.claimTtlMs },
            now,
            logger: log,
          },
          eventId,
        ),
      advanceStatus: (input) => advanceMessageStatus({ db, notifySink: socketNotify, now }, input),
      lifecycle,
    }),
  );

  // Task 18 (docs/04 §7): o worker da outbox corre como job recorrente.
  // Payload SEMPRE vazio (validado com zod); erro do tick → log + rethrow
  // (retry da fila). NÃO bloqueia o arranque: com Redis em baixo o BullMQ
  // enfileira o registo (offline queue) e aplica-o quando a ligação nascer —
  // a app tem de arrancar sem Redis (contrato Fase 0, config-startup.test.ts).
  const emptyPayload = z.object({}).strict();
  void jobs
    .registerRecurring(
      'outbox.tick',
      async (payload) => {
        const parsed = emptyPayload.safeParse(payload);
        if (!parsed.success) {
          log.error({ issues: parsed.error.issues }, 'outbox.tick.payload_invalid');
          throw new Error('outbox.tick: payload tem de ser vazio');
        }
        try {
          const { claimed, sent } = await runOutboxTick({
            db,
            provider: waProvider,
            accounts: lifecycle,
            notifySink: socketNotify,
            audit,
            now,
            random: Math.random,
            logger: log,
            cfg: {
              sendTimeoutMs: config.messaging.sendTimeoutMs,
              maxAttempts: config.messaging.sendMaxAttempts,
              retryDelayMs: config.messaging.outboxRetryDelayMs,
            },
          });
          log.info({ claimed, sent }, 'outbox.tick');
        } catch (error) {
          log.error(
            { err: { message: error instanceof Error ? error.message : String(error) } },
            'outbox.tick.failed',
          );
          throw error; // rethrow ⇒ a fila faz retry do tick
        }
      },
      { everyMs: config.messaging.outboxTickMs },
    )
    .catch((error: unknown) => {
      log.error(
        { err: { message: error instanceof Error ? error.message : String(error) } },
        'outbox.tick.register_failed',
      );
    });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'application.shutdown');
    void (async () => {
      try {
        await realtime.handle?.close(); // desliga clientes de socket e o server
        await app.close(); // para de aceitar ligações novas (tolera o 2º fecho)
        await jobs.close();
        redis.disconnect();
        await pool.end();
        process.exit(0);
      } catch (error) {
        log.error({ err: { message: (error as Error).message } }, 'shutdown.failed');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '127.0.0.1' });
  log.info({ nodeEnv: config.nodeEnv, port: config.port }, 'application.started');
}

void main().catch((error: unknown) => {
  // Erro de config: mensagem limpa no stderr, sem stack trace e sem valores das env.
  const message = error instanceof ConfigError ? error.message : (error as Error)?.message ?? String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
