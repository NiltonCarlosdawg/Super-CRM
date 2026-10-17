// Guards de auth (Onda 1, Task 3): o tenant do utilizador resolve-se POR PEDIDO
// (linha `users` + estado do tenant); o `role` gravado na sessão é só um
// snapshot de criação e não autoriza nada. Unitário: o hook é invocado
// diretamente com um request mínimo e fakes dos três deps.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { preHandlerHookHandler } from 'fastify';
import { HttpError } from '../../src/adapters/http/errors.js';
import { authenticate, requirePlatform, requireRole, requireTenant, type AuthContext } from '../../src/adapters/http/guards.js';
import type { AuthUserRepo, SessionRecord, SessionStore } from '../../src/ports/auth.js';
import type { TenancyPort } from '../../src/ports/tenancy.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeRequest {
  cookies: Record<string, string | undefined>;
  url: string;
  method: string;
  ip: string;
  auth?: AuthContext;
}

const fakeRequest = (session?: string): FakeRequest => ({
  cookies: session === undefined ? {} : { session },
  url: '/v1/auth/me',
  method: 'GET',
  ip: '127.0.0.1',
});

// O hook só toca em `request.cookies/method/url/ip/auth`; o FastifyInstance,
// reply e done do contrato Fastify não são usados — o cast (por unknown)
// permite invocá-lo diretamente aqui no unitário.
type GuardFn = (request: FakeRequest) => Promise<void>;
const invoke = (hook: preHandlerHookHandler): GuardFn => hook as unknown as GuardFn;

const sessionRecord = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 's-1',
  userId: 'u-1',
  role: 'admin',
  mfaPending: false,
  expiresAt: new Date(Date.now() + 3_600_000),
  ...over,
});

const sessionStore = (record: SessionRecord | null): SessionStore => ({
  create: async () => {
    throw new Error('não usado no teste');
  },
  get: async () => record,
  revoke: async () => {},
  revokeAllForUser: async () => {},
  setMfaPending: async () => {},
});

// Derivado do port: o fake mantém-se sincronizado com a forma devolvida.
type UserRow = NonNullable<Awaited<ReturnType<AuthUserRepo['findById']>>>;

const userRow = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'u-1',
  name: 'Utilizador',
  email: 'u@test.local',
  role: 'agent',
  active: true,
  passwordHash: 'hash',
  totpEnabledAt: null,
  tenantId: TENANT_A,
  ...over,
});

const userRepo = (user: UserRow | null): AuthUserRepo => ({
  findByEmail: async () => user,
  findById: async () => user,
  dummyHash: async () => 'dummy',
  updatePassword: async () => {},
});

/** TenancyPort fake: decide o estado por tenant e regista as chamadas. */
const tenancyPort = (fn: (tenantId: string) => 'active' | 'suspended' | null) => {
  const calls: string[] = [];
  const port: TenancyPort = {
    getStatus: async (tenantId) => {
      calls.push(tenantId);
      return fn(tenantId);
    },
  };
  return { port, calls };
};

test('platform_admin autentica com tenantId null e isPlatform true', async () => {
  const tenancy = tenancyPort(() => 'active');
  const guard = authenticate({
    sessions: sessionStore(sessionRecord({ role: 'platform_admin' })),
    users: userRepo(userRow({ role: 'platform_admin', tenantId: null })),
    tenancy: tenancy.port,
  });
  const request = fakeRequest('s-1');
  await invoke(guard)(request);
  assert.deepEqual(
    {
      sessionId: request.auth?.sessionId,
      userId: request.auth?.userId,
      role: request.auth?.role,
      tenantId: request.auth?.tenantId,
      isPlatform: request.auth?.isPlatform,
      ip: request.auth?.ip,
    },
    {
      sessionId: 's-1',
      userId: 'u-1',
      role: 'platform_admin',
      tenantId: null,
      isPlatform: true,
      ip: '127.0.0.1',
    },
  );
  // plataforma não pertence a nenhum tenant: o guard nunca consulta o estado
  assert.deepEqual(tenancy.calls, []);
});

test('tenant suspenso → HttpError(403, tenant_suspended)', async () => {
  const status = { value: 'active' as 'active' | 'suspended' | null };
  const tenancy = tenancyPort(() => status.value);
  const guard = authenticate({
    sessions: sessionStore(sessionRecord()),
    users: userRepo(userRow()),
    tenancy: tenancy.port,
  });

  // baseline: tenant ativo → autentica com o âmbito do tenant
  const active = fakeRequest('s-1');
  await invoke(guard)(active);
  assert.deepEqual(
    { tenantId: active.auth?.tenantId, isPlatform: active.auth?.isPlatform },
    { tenantId: TENANT_A, isPlatform: false },
  );
  assert.deepEqual(tenancy.calls, [TENANT_A]); // estado consultado por pedido

  // suspender o tenant → o pedido seguinte é recusado
  status.value = 'suspended';
  await assert.rejects(invoke(guard)(fakeRequest('s-1')), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'tenant_suspended');
    return true;
  });
});

test('papel vem da linha users por pedido, não da sessão (utilizador despromovido perde poderes no pedido seguinte)', async () => {
  const guard = authenticate({
    // snapshot de criação da sessão: ainda regista o papel antigo 'admin'
    sessions: sessionStore(sessionRecord({ role: 'admin' })),
    // linha users hoje: o utilizador já foi despromovido a agent
    users: userRepo(userRow({ role: 'agent' })),
    tenancy: tenancyPort(() => 'active').port,
  });
  const request = fakeRequest('s-1');
  await invoke(guard)(request);
  assert.equal(request.auth?.role, 'agent'); // autoridade = linha users
  // consequência: requireRole('admin') recusa o pedido seguinte
  await assert.rejects(invoke(requireRole('admin'))(request), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
    return true;
  });
});

// ─── Onda 1, Task 7 (rulings R2/R15 + spec §5.3) ─────────────────────────────

const authCtx = (over: Partial<AuthContext> = {}): AuthContext => ({
  sessionId: 's-1',
  userId: 'u-1',
  role: 'admin',
  tenantId: TENANT_A,
  isPlatform: false,
  mfaPending: false,
  ip: '127.0.0.1',
  ...over,
});

const reqAuth = (ctx: AuthContext): FakeRequest => ({ ...fakeRequest('s-1'), auth: ctx });

test('requirePlatform: só plataforma — tenant → 403 forbidden; sem sessão → 401', async () => {
  await assert.rejects(invoke(requirePlatform())(reqAuth(authCtx())), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
    return true;
  });
  await assert.rejects(invoke(requirePlatform())(fakeRequest('s-1')), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'unauthenticated');
    return true;
  });
  // plataforma autenticada passa (incluindo mfaPending — a recusa disso é do
  // authenticate, que fica fora do MFA_ALLOWLIST)
  await invoke(requirePlatform())(reqAuth(authCtx({ role: 'platform_admin', tenantId: null, isPlatform: true })));
  await invoke(requirePlatform())(reqAuth(authCtx({ role: 'platform_admin', tenantId: null, isPlatform: true, mfaPending: true })));
});

test('requireTenant: plataforma em rota de tenant → 403 forbidden; sessão de tenant passa (R2/R15)', async () => {
  await assert.rejects(
    invoke(requireTenant())(reqAuth(authCtx({ role: 'platform_admin', tenantId: null, isPlatform: true }))),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'forbidden');
      return true;
    },
  );
  await assert.rejects(invoke(requireTenant())(fakeRequest('s-1')), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 401);
    return true;
  });
  // qualquer papel de tenant passa (agent mesmo em rota admin-only: o papel decide depois)
  await invoke(requireTenant())(reqAuth(authCtx()));
  await invoke(requireTenant())(reqAuth(authCtx({ role: 'admin' })));
});
