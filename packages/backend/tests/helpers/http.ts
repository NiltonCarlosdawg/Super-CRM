// buildTestApp (Task 9): app HTTP real com BD de teste migrada, utilizadores
// sintéticos um por papel (mesma password), MfaPort fake (código fixo
// '123456') e login DIRETO pelo serviço para criar as cookies de teste.
// A BD é reiniciada entre apps: a segunda buildTestApp não vê dados da primeira.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildHttpApp } from '../../src/adapters/http/app.js';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createAuthUserRepo, createSessionStore } from '../../src/adapters/db/auth.js';
import { createConversationsRepository } from '../../src/adapters/db/conversations.js';
import type { DbClient } from '../../src/adapters/db/index.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import { createUsersRepository } from '../../src/adapters/db/users.js';
import { attachRealtime, type RealtimeHandle } from '../../src/adapters/realtime/socket.js';
import { createLoginService } from '../../src/application/auth/login.js';
import { createLoginLimiter } from '../../src/application/auth/login-limiter.js';
import { createMessageSender } from '../../src/application/messaging.js';
import type { AuthConfig } from '../../src/infra/config-app.js';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import type { MfaPort, SessionStore } from '../../src/ports/auth.js';
import type { JobQueue } from '../../src/ports/job-queue.js';
import type { AccountsRepository } from '../../src/ports/accounts.js';
import type { MessagingProvider } from '../../src/ports/messaging-provider.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import pino from 'pino';
import { migratedDb } from './db.js';

export const TEST_PASSWORD = 'senha-muito-forte-123';

export const testAuthConfig: AuthConfig = {
  authSecret: 'x'.repeat(32),
  sessionTtlHours: 72,
  // loginRateMax alto de propósito: os testes fazem vários logins do mesmo
  // email sem querer exercitar o limiter (coberto no teste unitário da Task 7
  // e no de integração do login).
  loginRateMax: 100,
  loginRateWindowMs: 60_000,
  loginLockMaxMs: 3_600_000,
  totpIssuer: 'MilVendas',
  httpRateMax: 300,
  httpRateWindowMs: 60_000,
  bodyLimitBytes: 1_048_576,
};

/** MfaPort fake (passo 7): código fixo '123456'; limpa mfaPending sem ativar TOTP. */
function createFakeMfa(sessions: SessionStore): MfaPort {
  return {
    startSetup: async ({ email }) => ({
      otpauthUrl: `otpauth://totp/MilVendas:${email}?secret=FAKESECRET23456789&issuer=MilVendas`,
    }),
    verifyAndFinish: async ({ sessionId, code }) => {
      if (code !== '123456') return false;
      await sessions.setMfaPending(sessionId, false, new Date());
      return true;
    },
  };
}

/** MessagingProvider fake (Task 16): sem rede; sessões `fake-<uuid>` e QR fixo.
 *  Task 21: regista as chamadas a sendText — os testes provam que nenhum envio
 *  acontece fora da outbox. */
export function createFakeWaProvider(): MessagingProvider & {
  sendTextCalls: Array<{ sessionId: string; to: string; text: string; idempotencyKey: string }>;
} {
  const sendTextCalls: Array<{ sessionId: string; to: string; text: string; idempotencyKey: string }> = [];
  return {
    name: 'fake-wa',
    health: async () => ({ ok: true }),
    createSession: async () => ({ sessionId: `fake-${randomUUID()}` }),
    getSession: async () => ({ status: 'connected' as const }),
    getQr: async () => ({ qr: 'QR-FAKE' }),
    logout: async () => {},
    sendText: async (input) => {
      sendTextCalls.push(input);
      return { providerMessageId: null, outcome: 'unknown' as const };
    },
    sendMedia: async () => ({ providerMessageId: null, outcome: 'unknown' as const }),
    verifyAndParseWebhook: () => [],
    sendTextCalls,
  };
}

export interface TestApp extends FastifyInstance {
  sessions: { agent: string; editor: string; admin: string };
  csrf: { agent: string; editor: string; admin: string };
  users: { agent: UserInfo; editor: UserInfo; admin: UserInfo };
  db: DbClient;
  /** Task 15: Socket.IO ligado ao httpServer (fecha antes do Fastify). */
  realtime: RealtimeHandle;
  /** Task 16: contas WhatsApp — repo real, provider fake e eventos emitidos. */
  accounts: AccountsRepository;
  waProvider: MessagingProvider;
  notifyLog: NotifyEvent[];
  close(): Promise<void>;
}

export interface UserInfo {
  id: string;
  name: string;
  email: string;
}

export async function buildTestApp(
  overrides?: {
    /** Task 20: adaptador REAL do WA-AKG para exercitar assinatura de webhook. */
    waProvider?: MessagingProvider;
    /** Task 20: fila capturadora (os testes inspecionam os jobs enfileirados). */
    jobs?: JobQueue;
  },
): Promise<TestApp> {
  const db = await migratedDb();
  const hasher = createArgon2Hasher();
  const passwordHash = await hasher.hash(TEST_PASSWORD);

  const mk = async (name: string, email: string, role: 'agent' | 'editor' | 'admin'): Promise<UserInfo> => {
    const [row] = await db
      .insert(users)
      .values({ tenantId: MILVENDAS_TENANT_ID, name, email, passwordHash, role, active: true })
      .returning({ id: users.id, name: users.name, email: users.email });
    if (row === undefined) throw new Error('falhou criar utilizador sintético');
    return row;
  };
  const agent = await mk('Agente', 'agent@test.local', 'agent');
  const editor = await mk('Editor', 'editor@test.local', 'editor');
  const admin = await mk('Admin', 'admin@test.local', 'admin');

  const sessions = createSessionStore({ db });
  const usersRepo = createAuthUserRepo({ db, hasher });
  const audit = createAuditAdapter({ db });
  const mfa = createFakeMfa(sessions);
  // Task 16: provider falso determinístico (não há rede em testes) + repo de
  // contas real; os eventos de logout/transição ficam no notifyLog do TestApp.
  // Task 20: pode receber o adaptador REAL (assinatura de webhook) e a fila.
  const waProvider = overrides?.waProvider ?? createFakeWaProvider();
  const jobs = overrides?.jobs;
  const accounts = createAccountsRepository({ db });
  const notifyLog: NotifyEvent[] = [];
  const cfg = { nodeEnv: 'test' as const, auth: testAuthConfig };
  const limiter = createLoginLimiter(
    { max: testAuthConfig.loginRateMax, windowMs: testAuthConfig.loginRateWindowMs, lockMaxMs: testAuthConfig.loginLockMaxMs },
    () => new Date(),
  );
  const login = createLoginService({ users: usersRepo, sessions, hasher, mfa, limiter, audit, cfg: testAuthConfig, now: () => new Date() });

  // Task 21: leitura/envio de conversas — outbox REAL (a única saída de
  // mensagens) com janela [1000, 5000] ms para o teste de scheduledAt.
  const conversations = createConversationsRepository(db);
  const outbox = createOutbox({
    db,
    notifySink: async (e) => {
      notifyLog.push(e);
    },
    now: () => new Date(),
    random: Math.random,
    replyDelay: { min: 1000, max: 5000 },
  });
  const messageSender = createMessageSender({
    outbox,
    repo: conversations,
    audit,
    cfg: { maxMessageChars: 4096 },
    now: () => new Date(),
  });

  const app = buildHttpApp({
    cfg,
    db,
    users: usersRepo,
    usersRepo: createUsersRepository({ db }),
    audit,
    hasher,
    sessions,
    login,
    mfa,
    logger: pino({ level: 'silent' }),
    now: () => new Date(),
    accounts,
    waProvider,
    jobs,
    conversations,
    messageSender,
    notifySink: async (e) => {
      notifyLog.push(e);
    },
  });

  // login direto pelo serviço (não HTTP) para criar as cookies de teste
  const viaLogin = async (email: string): Promise<{ sessionId: string }> => {
    const r = await login.login({ email, password: TEST_PASSWORD, ip: '127.0.0.1' });
    if (r.status === 'ok' || r.status === 'mfa_setup_required' || r.status === 'mfa_required') {
      return { sessionId: r.sessionId };
    }
    throw new Error(`login direto falhou para ${email}: ${r.status}`);
  };
  const agentS = await viaLogin(agent.email);
  const editorS = await viaLogin(editor.email);
  const adminS = await viaLogin(admin.email); // admin sem TOTP → mfa_setup_required
  // completa o MFA do admin com o código fixo do fake → sessão utilizável
  await mfa.verifyAndFinish({ sessionId: adminS.sessionId, userId: admin.id, code: '123456', now: new Date() });

  const withHelpers = app as TestApp;
  withHelpers.sessions = { agent: agentS.sessionId, editor: editorS.sessionId, admin: adminS.sessionId };
  withHelpers.csrf = { agent: randomUUID(), editor: randomUUID(), admin: randomUUID() };
  withHelpers.users = { agent, editor, admin };
  withHelpers.db = db;
  withHelpers.accounts = accounts;
  withHelpers.waProvider = waProvider;
  withHelpers.notifyLog = notifyLog;
  // Task 15: Socket.IO no mesmo httpServer; o fecho vai primeiro pelo realtime
  // (desliga clientes e o server) e depois pelo Fastify (que tolera o 2º fecho).
  const realtime = attachRealtime({ server: app.server, sessions, now: () => new Date() });
  withHelpers.realtime = realtime;
  const baseClose = app.close.bind(app);
  withHelpers.close = async (): Promise<void> => {
    await realtime.close();
    await baseClose();
  };
  return withHelpers;
}
