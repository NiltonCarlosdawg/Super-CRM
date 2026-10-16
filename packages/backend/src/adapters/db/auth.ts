// Adaptadores de auth sobre PostgreSQL (A2, docs/06): sessões server-side e
// repositório de utilizadores. Falam só com as tabelas da Fase 0 via Drizzle.

import { randomUUID } from 'node:crypto';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { AuthUserRepo, SessionRecord, SessionStore, UserTotpRepo } from '../../ports/auth.js';
import type { PasswordHasher } from '../../ports/security.js';
import type { DbClient } from './index.js';
import { sessions } from './schema/sessions.schema.js';
import { users } from './schema/users.schema.js';

export function createSessionStore(deps: { db: DbClient }): SessionStore {
  return {
    async create(input) {
      // A PK é o valor do cookie, gerado aqui (randomUUID, A2)
      const sessionId = randomUUID();
      const expiresAt = new Date(input.now.getTime() + input.ttlHours * 3_600_000);
      await deps.db
        .insert(sessions)
        .values({ id: sessionId, userId: input.userId, expiresAt, mfaPending: input.mfaPending });
      return { sessionId, expiresAt };
    },

    async get(sessionId, now) {
      // JOIN users: papel do utilizador E utilizador inativo revoga a sessão de facto
      const rows = await deps.db
        .select({
          sessionId: sessions.id,
          userId: sessions.userId,
          role: users.role,
          mfaPending: sessions.mfaPending,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now), eq(users.active, true)));
      const r: SessionRecord | undefined = rows[0];
      return r ?? null; // expirada ou revogada (DELETE) → nula
    },

    async revoke(sessionId) {
      await deps.db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async revokeAllForUser(userId, exceptSessionId) {
      const cond =
        exceptSessionId === undefined
          ? eq(sessions.userId, userId)
          : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId));
      await deps.db.delete(sessions).where(cond);
    },

    async setMfaPending(sessionId, mfaPending, now) {
      await deps.db
        .update(sessions)
        .set({ mfaPending, updatedAt: now })
        .where(eq(sessions.id, sessionId));
    },
  };
}

/** Utilizador + TOTP: o mesmo repositório serve o login e o MFA (Task 8). */
export function createAuthUserRepo(deps: {
  db: DbClient;
  hasher: PasswordHasher;
}): AuthUserRepo & UserTotpRepo {
  let dummy: Promise<string> | undefined;

  const map = (r: typeof users.$inferSelect) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active,
    tenantId: r.tenantId, // Task 3: âmbito resolvido por pedido no guard de auth
    passwordHash: r.passwordHash,
    totpEnabledAt: r.totpEnabledAt,
  });

  return {
    async findByEmail(email) {
      // email normalizado: trim + lowercase (docs/02 §3 — validar na fronteira)
      const rows = await deps.db
        .select()
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()));
      const r = rows[0];
      return r === undefined ? null : map(r);
    },

    async findById(userId) {
      const rows = await deps.db.select().from(users).where(eq(users.id, userId));
      const r = rows[0];
      return r === undefined ? null : map(r);
    },

    // argon2id de constante fixa, gerado uma vez no arranque: mesmo custo de
    // verificação quando o utilizador não existe (anti-enumeração, docs/03)
    dummyHash() {
      return (dummy ??= deps.hasher.hash('dummy-password-constante-anti-enumeracao'));
    },

    async updatePassword(userId, passwordHash, now) {
      await deps.db
        .update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, userId));
    },

    // ── UserTotpRepo (Task 8): segredo SEMPRE cifrado em BD ──

    async getTotpState(userId) {
      const rows = await deps.db
        .select({
          encryptedSecret: users.totpSecret,
          totpEnabledAt: users.totpEnabledAt,
          tenantId: users.tenantId, // Task 4: auditoria de auth.totp_enabled
        })
        .from(users)
        .where(eq(users.id, userId));
      const r = rows[0];
      if (r === undefined || r.encryptedSecret === null) return null;
      return { encryptedSecret: r.encryptedSecret, totpEnabledAt: r.totpEnabledAt, tenantId: r.tenantId };
    },

    async setTotpSecret(userId, encryptedSecret, now) {
      await deps.db
        .update(users)
        .set({ totpSecret: encryptedSecret, updatedAt: now })
        .where(eq(users.id, userId));
    },

    async setTotpEnabled(userId, now) {
      await deps.db
        .update(users)
        .set({ totpEnabledAt: now, updatedAt: now })
        .where(eq(users.id, userId));
    },
  };
}
