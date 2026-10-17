// Onda 1, Task 12 (ruling R29): `startSetup` recusa quando o TOTP já está
// ACTIVO. A rotação silenciosa do segredo activo (setTotpSecret antes de
// qualquer verify) daria lockout no próximo login: o authenticator guarda o
// código velho, a BD tem o novo — nenhum código serve. O guarda recusa com
// DomainError (a fronteira mapeia para 409); o setup pendente (secret novo,
// totpEnabledAt null) continua a funcionar.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMfaService } from '../../src/application/auth/mfa.js';
import { DomainError } from '../../src/domain/error.js';
import type { AuthConfig } from '../../src/infra/config-app.js';
import type { SessionStore, UserTotpRepo } from '../../src/ports/auth.js';
import type { Totp } from '../../src/ports/security.js';

const cfg: AuthConfig = {
  authSecret: 'x'.repeat(32),
  sessionTtlHours: 72,
  loginRateMax: 5,
  loginRateWindowMs: 900_000,
  loginLockMaxMs: 3_600_000,
  totpIssuer: 'MilVendas',
  httpRateMax: 300,
  httpRateWindowMs: 60_000,
  bodyLimitBytes: 1_048_576,
};

const USER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CIPHERTEXT = 'segredo-cifrado-existente';

/** Repo fake: devolve o estado TOTP fixado e regista as chamadas de escrita. */
function fakeUsers(state: { encryptedSecret: string; totpEnabledAt: Date | null } | null): {
  repo: UserTotpRepo;
  writes: Array<{ op: 'setTotpSecret' | 'setTotpEnabled'; secret?: string }>;
} {
  const writes: Array<{ op: 'setTotpSecret' | 'setTotpEnabled'; secret?: string }> = [];
  const repo: UserTotpRepo = {
    async getTotpState() {
      return state === null ? null : { ...state, tenantId: TENANT };
    },
    async setTotpSecret(_userId, encryptedSecret) {
      writes.push({ op: 'setTotpSecret', secret: encryptedSecret });
    },
    async setTotpEnabled() {
      writes.push({ op: 'setTotpEnabled' });
    },
  };
  return { repo, writes };
}

const totp: Totp = {
  generateSecret: () => 'A'.repeat(32),
  generate: () => '000000',
  otpauthUrl: ({ secret }) => `otpauth://totp/MilVendas:a@b.c?secret=${secret}`,
  verify: () => true,
};

const noop = async () => {};
const sessions: SessionStore = {
  create: async () => ({ sessionId: 's', expiresAt: new Date() }),
  get: async () => null,
  revoke: noop,
  revokeAllForUser: noop,
  setMfaPending: noop,
};
const audit = { record: noop };

function service(state: { encryptedSecret: string; totpEnabledAt: Date | null } | null) {
  const { repo, writes } = fakeUsers(state);
  const mfa = createMfaService({ users: repo, sessions, totp, cfg, audit, now: () => new Date() });
  return { mfa, writes };
}

test('startSetup recusa com totp_already_enabled quando o TOTP já está activo', async () => {
  const { mfa, writes } = service({ encryptedSecret: CIPHERTEXT, totpEnabledAt: new Date('2026-10-10T09:00:00Z') });

  await assert.rejects(
    () => mfa.startSetup({ userId: USER, email: 'a@b.c', now: new Date() }),
    (e: unknown) => e instanceof DomainError && e.code === 'totp_already_enabled',
  );
  // NENHUMA escrita: o segredo activo fica intacto (nada de rotação silenciosa)
  assert.deepEqual(writes, []);
});

test('startSetup funciona com segredo pendente (totpEnabledAt null)', async () => {
  const { mfa, writes } = service({ encryptedSecret: CIPHERTEXT, totpEnabledAt: null });

  const { otpauthUrl } = await mfa.startSetup({ userId: USER, email: 'a@b.c', now: new Date() });
  assert.match(otpauthUrl, /^otpauth:\/\//);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.op, 'setTotpSecret');
});

test('startSetup funciona sem segredo prévio (primeiro setup)', async () => {
  const { mfa, writes } = service(null);

  const { otpauthUrl } = await mfa.startSetup({ userId: USER, email: 'a@b.c', now: new Date() });
  assert.match(otpauthUrl, /^otpauth:\/\//);
  assert.deepEqual(writes.map((w) => w.op), ['setTotpSecret']);
});
