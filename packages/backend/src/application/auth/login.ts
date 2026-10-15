// Caso de uso de login (A2, docs/06; plano Fase 1 Task 7): bloqueio progressivo,
// anti-enumeração (dummyHash + mesma resposta), arranque de TOTP para admin,
// auditoria de sucesso/falha. Relógio SEMPRE via `deps.now()` (docs/02 §3).

import { DomainError } from '../../domain/error.js';
import { assertPasswordPolicy } from '../../domain/password.js';
import type { AuthConfig } from '../../infra/config-app.js';
import type { Audit } from '../../ports/audit.js';
import type { AuthUserRepo, MfaPort, Role, SessionRecord, SessionStore } from '../../ports/auth.js';
import type { PasswordHasher } from '../../ports/security.js';
import type { LoginLimiter } from './login-limiter.js';

export type LoginResult =
  | { status: 'ok'; sessionId: string; expiresAt: Date; user: { id: string; name: string; email: string; role: Role } }
  | { status: 'mfa_setup_required'; sessionId: string; expiresAt: Date; otpauthUrl: string }
  | { status: 'mfa_required'; sessionId: string; expiresAt: Date }
  | { status: 'invalid_credentials' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

// entityId do audit para tentativas sem utilizador (audit_log.entity_id é uuid).
const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000';

export function createLoginService(deps: {
  users: AuthUserRepo;
  sessions: SessionStore;
  hasher: PasswordHasher;
  mfa: MfaPort;
  limiter: LoginLimiter;
  audit: Audit;
  cfg: AuthConfig;
  now(): Date;
}) {
  return {
    async login(input: { email: string; password: string; ip: string }): Promise<LoginResult> {
      const key = `${input.email}|${input.ip}`;
      const now = deps.now();

      const gate = deps.limiter.check(key);
      if (!gate.allowed) {
        return { status: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds };
      }

      const user = await deps.users.findByEmail(input.email);
      // dummyHash quando não existe: mesmo custo de verificação (anti-enumeração)
      const hash = user?.passwordHash ?? (await deps.users.dummyHash());
      const valid = await deps.hasher.verify(hash, input.password);

      if (user === null || !user.active || !valid) {
        deps.limiter.fail(key);
        await deps.audit.record({
          actorId: null,
          action: 'auth.login_failed',
          entity: 'user',
          entityId: user?.id ?? UNKNOWN_USER_ID,
          detail: { email: input.email }, // nunca a password (docs/03)
          at: now,
          ip: input.ip,
        });
        return { status: 'invalid_credentials' };
      }

      deps.limiter.reset(key);

      // admin sem TOTP: sessão criada mas inutilizável até configurar (Task 8)
      if (user.role === 'admin' && user.totpEnabledAt === null) {
        const { sessionId, expiresAt } = await deps.sessions.create({
          userId: user.id, role: user.role, mfaPending: true, now,
          ttlHours: deps.cfg.sessionTtlHours, ip: input.ip,
        });
        const { otpauthUrl } = await deps.mfa.startSetup({ userId: user.id, email: user.email, now });
        return { status: 'mfa_setup_required', sessionId, expiresAt, otpauthUrl };
      }

      const { sessionId, expiresAt } = await deps.sessions.create({
        userId: user.id, role: user.role, mfaPending: false, now,
        ttlHours: deps.cfg.sessionTtlHours, ip: input.ip,
      });
      await deps.audit.record({
        actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, at: now, ip: input.ip,
      });
      return {
        status: 'ok', sessionId, expiresAt,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      };
    },

    async logout(sessionId: string): Promise<void> {
      await deps.sessions.revoke(sessionId); // revogação = DELETE (A2)
    },

    async loadSession(sessionId: string): Promise<SessionRecord | null> {
      return deps.sessions.get(sessionId, deps.now());
    },

    async changePassword(input: {
      sessionId: string; currentPassword: string; newPassword: string; ip: string;
    }): Promise<void> {
      const now = deps.now();
      const session = await deps.sessions.get(input.sessionId, now);
      if (session === null) throw new DomainError('unauthenticated');
      const user = await deps.users.findById(session.userId);
      if (user === null) throw new DomainError('unauthenticated');
      const valid = await deps.hasher.verify(user.passwordHash, input.currentPassword);
      if (!valid) throw new DomainError('invalid_credentials');
      assertPasswordPolicy(input.newPassword);
      await deps.users.updatePassword(user.id, await deps.hasher.hash(input.newPassword), now);
      // revoga as outras sessões do utilizador (mantém a atual)
      await deps.sessions.revokeAllForUser(user.id, input.sessionId);
      await deps.audit.record({
        actorId: user.id, action: 'auth.password_changed', entity: 'user', entityId: user.id,
        at: now, ip: input.ip,
      });
    },
  };
}
