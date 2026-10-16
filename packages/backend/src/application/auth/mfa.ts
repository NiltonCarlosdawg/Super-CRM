// MFA (TOTP) — implementa o MfaPort da Task 7 com o TOTP real (Task 8).
// `startSetup` gera e persiste o segredo CIFRADO (AES-256-GCM sob AUTH_SECRET);
// `verifyAndFinish` decifra, valida o código e só então ativa TOTP e limpa
// `mfaPending`. Registo de auditoria `auth.totp_enabled`.

import type { Audit } from '../../ports/audit.js';
import type { MfaPort, SessionStore, UserTotpRepo } from '../../ports/auth.js';
import type { Totp } from '../../ports/security.js';
import type { AuthConfig } from '../../infra/config-app.js';
import { decryptSecret, encryptSecret } from '../../infra/security/totp.js';

export function createMfaService(deps: {
  users: UserTotpRepo;
  sessions: SessionStore;
  totp: Totp;
  cfg: AuthConfig;
  audit: Audit;
  now(): Date;
}): MfaPort {
  return {
    async startSetup({ userId, email, now }) {
      const secret = deps.totp.generateSecret();
      await deps.users.setTotpSecret(userId, encryptSecret(secret, deps.cfg.authSecret), now);
      return {
        otpauthUrl: deps.totp.otpauthUrl({
          secret,
          accountEmail: email,
          issuer: deps.cfg.totpIssuer,
        }),
      };
    },

    async verifyAndFinish({ sessionId, userId, code, now }) {
      const state = await deps.users.getTotpState(userId);
      if (state === null) return false;
      const secret = decryptSecret(state.encryptedSecret, deps.cfg.authSecret);
      if (!deps.totp.verify({ secret, code, at: now })) return false;

      await deps.users.setTotpEnabled(userId, now);
      await deps.sessions.setMfaPending(sessionId, false, now);
      await deps.audit.record({
        tenantId: state.tenantId, // Task 4: null = platform_admin (spec §4.2)
        actorId: userId,
        action: 'auth.totp_enabled',
        entity: 'user',
        entityId: userId,
        at: now,
      });
      return true;
    },
  };
}
