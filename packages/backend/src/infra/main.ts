// Arranque da aplicação (Fase 1, Task 9): config validada → pool/pg, Redis e
// fila → auth real (argon2 + TOTP) → Fastify a escutar → graceful shutdown
// (SIGTERM/SIGINT: fecha realtime (Socket.IO) → server → fila → Redis → pool).

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { buildHttpApp } from '../adapters/http/app.js';
import { createAuditAdapter } from '../adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../adapters/db/auth.js';
import { createDb } from '../adapters/db/index.js';
import { createUsersRepository } from '../adapters/db/users.js';
import { createJobQueue } from '../adapters/queue/index.js';
import { attachRealtime } from '../adapters/realtime/socket.js';
import { createLoginService } from '../application/auth/login.js';
import { createLoginLimiter } from '../application/auth/login-limiter.js';
import { createMfaService } from '../application/auth/mfa.js';
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
    readyChecks: [{ name: 'redis', run: () => redis.ping() }],
  });

  // Task 15: Socket.IO no mesmo httpServer (handshake autenticado por sessão).
  const realtime = attachRealtime({ server: app.server, sessions, now });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'application.shutdown');
    void (async () => {
      try {
        await realtime.close(); // desliga clientes de socket e o server
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
