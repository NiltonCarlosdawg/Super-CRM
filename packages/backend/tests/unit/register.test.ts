// Registo público (Onda 1, Task 6; spec multitenant §5.1): tenant + admin do
// tenant numa transacção ATÓMICA, papel FIXO 'admin' (o papel nunca vem do
// corpo), email normalizado na fronteira e auto-login DEPOIS do commit.
// Unitário com fakes: o `db` fake só implementa a transacção (único método
// usado pelo serviço), com rollback em memória e a unicidade real de
// `users.email` (23505), como a do Postgres.

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DbClient } from '../../src/adapters/db/index.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { tenants } from '../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../src/adapters/db/schema/users.schema.js';
import type { createLoginService } from '../../src/application/auth/login.js';
import { createRegisterService } from '../../src/application/auth/register.js';
import { DomainError } from '../../src/domain/error.js';
import type { Audit } from '../../src/ports/audit.js';
import type { PasswordHasher } from '../../src/ports/security.js';

type Row = Record<string, unknown>;

interface Store {
  tenants: Row[];
  users: Row[];
  audit_log: Row[];
}

// Identidade do objecto-schema (o serviço e o teste importam o MESMO módulo).
const tableKey = (table: unknown): 'tenants' | 'users' | 'audit_log' => {
  if (table === tenants) return 'tenants';
  if (table === users) return 'users';
  if (table === auditLog) return 'audit_log';
  throw new Error('tabela desconhecida no fake do registo');
};

/** Fake de DbClient: só `transaction`. Linhas do callback ficam em staging e só
 *  entram na store no COMMIT — um throw a meio descarta-as (rollback), como o
 *  Postgres faz. */
function fakeDb(store: Store): DbClient {
  const db = {
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      const staged: Array<{ table: 'tenants' | 'users' | 'audit_log'; row: Row }> = [];
      const tx = {
        insert(table: unknown) {
          const key = tableKey(table);
          return {
            values(values: Row) {
              const apply = (): Row[] => {
                if (key === 'users') {
                  const email = String(values.email);
                  const seen = [
                    ...store.users,
                    ...staged.filter((s) => s.table === 'users').map((s) => s.row),
                  ];
                  if (seen.some((r) => r.email === email)) {
                    throw Object.assign(
                      new Error('duplicate key value violates unique constraint "users_email_unique"'),
                      { code: '23505' },
                    );
                  }
                }
                const row: Row = { id: randomUUID(), ...values };
                staged.push({ table: key, row });
                return [row];
              };
              return {
                returning: async () => apply(),
                // `await builder` sem `.returning()` (o INSERT do audit) também insere
                then(onOk: (rows: Row[]) => unknown, onErr: (e: unknown) => unknown): Promise<unknown> {
                  return Promise.resolve()
                    .then(apply)
                    .then(onOk, onErr);
                },
              };
            },
          };
        },
      };
      const result = await cb(tx);
      for (const s of staged) store[s.table].push(s.row); // COMMIT
      return result;
    },
  };
  // Cast: o fake cobre apenas `transaction`, o único método usado pelo serviço.
  return db as unknown as DbClient;
}

type LoginService = ReturnType<typeof createLoginService>;

interface LoginCall {
  email: string;
  password: string;
  ip: string;
  /** Users já COMMITADOS quando o auto-login correu (pós-transacção). */
  committedUsers: number;
}

/** LoginService fake: devolve sempre o estado de setup TOTP (admin sem TOTP). */
function fakeLogin(store: Store, calls: LoginCall[]): LoginService {
  return {
    async login(input) {
      calls.push({ ...input, committedUsers: store.users.length });
      return {
        status: 'mfa_setup_required',
        sessionId: 'session-registo-1',
        expiresAt: new Date('2026-10-16T12:00:00.000Z'),
        otpauthUrl: 'otpauth://totp/MilVendas:registo?secret=FAKESECRET&issuer=MilVendas',
      };
    },
    async logout() {},
    async loadSession() {
      return null;
    },
    async changePassword() {},
  };
}

const CLOCK = new Date('2026-10-16T10:00:00.000Z');
const SENHA = 'senha-super-forte-99';

function makeService(seed?: (store: Store) => void) {
  const store: Store = { tenants: [], users: [], audit_log: [] };
  seed?.(store);
  const hasherCalls: string[] = [];
  const hasher: PasswordHasher = {
    hash: async (plain) => {
      hasherCalls.push(plain);
      return 'hash-fake-argon2';
    },
    verify: async () => true,
  };
  // `deps.audit` é o port do contrato (assinatura do brief); o serviço pode
  // escrever o audit pela transacção — o fake cobre os dois caminhos.
  const audit: Audit = {
    record: async (input) => {
      store.audit_log.push({ ...input });
    },
  };
  const loginCalls: LoginCall[] = [];
  const svc = createRegisterService({
    db: fakeDb(store),
    hasher,
    audit,
    login: fakeLogin(store, loginCalls),
    now: () => CLOCK,
  });
  return { svc, store, loginCalls, hasherCalls };
}

test('register cria tenant + admin e devolve mfa_setup', async () => {
  const { svc, store, loginCalls, hasherCalls } = makeService();

  const r = await svc.register({
    tenantName: 'Acme LDA',
    name: 'Fundador',
    email: '  Founder@Exemplo.COM ', // normalizado na fronteira (lower+trim)
    password: SENHA,
    ip: '10.9.9.9',
  });
  if (r.status !== 'created') assert.fail(`esperava 'created'; veio '${r.status}'`);
  assert.equal(r.sessionId, 'session-registo-1');
  assert.equal(r.expiresAt.toISOString(), '2026-10-16T12:00:00.000Z');
  assert.match(r.otpauthUrl, /^otpauth:\/\//);

  // tenant criado
  assert.equal(store.tenants.length, 1);
  const tenant = store.tenants[0]!;
  assert.equal(tenant.name, 'Acme LDA');

  // admin NO tenant: papel fixo, email normalizado, hash (nunca texto claro)
  assert.equal(store.users.length, 1);
  const user = store.users[0]!;
  assert.equal(user.role, 'admin');
  assert.equal(user.tenantId, tenant.id);
  assert.equal(user.email, 'founder@exemplo.com');
  assert.equal(user.active, true);
  assert.equal(user.passwordHash, 'hash-fake-argon2');
  assert.deepEqual(hasherCalls, [SENHA]);

  // audit 'auth.register' no tenant novo (spec §5.4)
  assert.equal(store.audit_log.length, 1);
  const auditRow = store.audit_log[0]!;
  assert.equal(auditRow.action, 'auth.register');
  assert.equal(auditRow.tenantId, tenant.id);
  assert.equal(auditRow.actorId, user.id);

  // auto-login DEPOIS do commit: o fake vê a store já populada
  assert.equal(loginCalls.length, 1);
  assert.equal(loginCalls[0]!.email, 'founder@exemplo.com');
  assert.equal(loginCalls[0]!.password, SENHA);
  assert.equal(loginCalls[0]!.ip, '10.9.9.9');
  assert.equal(loginCalls[0]!.committedUsers, 1);
});

test('email repetido → email_exists (e o tenant não fica órfão)', async () => {
  const { svc, store, loginCalls } = makeService((s) => {
    s.users.push({
      id: randomUUID(),
      tenantId: randomUUID(),
      name: 'Repetido',
      email: 'dup@exemplo.com',
      passwordHash: 'hash-fake-argon2',
      role: 'admin',
      active: true,
    });
  });

  const r = await svc.register({
    tenantName: 'Outra Empresa',
    name: 'Repetido',
    email: ' DUP@Exemplo.COM ', // a unicidade é global e o email já está normalizado
    password: SENHA,
    ip: '10.9.9.8',
  });
  assert.deepEqual(r, { status: 'email_exists' });
  assert.equal(store.tenants.length, 0); // ROLLBACK: nenhum tenant órfão
  assert.equal(store.users.length, 1); // só a linha pré-existente
  assert.equal(store.audit_log.length, 0); // nem audit
  assert.equal(loginCalls.length, 0); // sem auto-login
});

test('password de 11 caracteres → DomainError weak_password', async () => {
  const { svc, store, loginCalls, hasherCalls } = makeService();

  await assert.rejects(
    () =>
      svc.register({
        tenantName: 'Curta',
        name: 'Alguém',
        email: 'curta@exemplo.com',
        password: 'senha-12345', // 11 caracteres (política: 12–100)
        ip: '10.9.9.7',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'weak_password',
  );
  assert.equal(store.tenants.length, 0); // nenhum trabalho de BD antes da política
  assert.equal(store.users.length, 0);
  assert.equal(store.audit_log.length, 0);
  assert.equal(hasherCalls.length, 0); // nem sequer hasheia
  assert.equal(loginCalls.length, 0);
});

test('o papel NÃO vem do corpo (role=admin fixo)', async () => {
  const { svc, store } = makeService();
  // O corpo HTTP pode trazer `role` (a fronteira zod corta-o); o input do
  // serviço não tem esse campo e o papel é fixo — platform_admin não é registável.
  const input = {
    tenantName: 'Sem Papel',
    name: 'Alguém',
    email: 'nopapel@exemplo.com',
    password: SENHA,
    ip: '10.9.9.6',
    role: 'platform_admin',
  };
  const r = await svc.register(input as Parameters<typeof svc.register>[0]);
  assert.equal(r.status, 'created');
  assert.equal(store.users[0]?.role, 'admin');
  assert.notEqual(store.users[0]?.role, 'platform_admin');
});
