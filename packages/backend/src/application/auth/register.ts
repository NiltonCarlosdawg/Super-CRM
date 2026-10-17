// Caso de uso de registo público (Onda 1, Task 6; spec multitenant §5.1):
// cria um tenant + o seu admin numa transacção ATÓMICA (tenant → user →
// audit) e auto-loga com o LoginService existente, devolvendo a MESMA resposta
// do login para o frontend reutilizar o fluxo TOTP. Relógio SEMPRE via
// `deps.now()` (docs/02 §3); email normalizado ANTES de qualquer I/O.

import { createAuditAdapter } from '../../adapters/db/audit-adapter.js';
import type { DbClient } from '../../adapters/db/index.js';
import { tenants } from '../../adapters/db/schema/tenants.schema.js';
import { users } from '../../adapters/db/schema/users.schema.js';
import { assertPasswordPolicy } from '../../domain/password.js';
import type { Audit } from '../../ports/audit.js';
import type { PasswordHasher } from '../../ports/security.js';
import type { createLoginService } from './login.js';

export type RegisterResult =
  | { status: 'created'; sessionId: string; expiresAt: Date; otpauthUrl: string }
  | { status: 'email_exists' };

/** Violação de UNIQUE (23505) do Postgres; o Drizzle embrulha o erro em `cause`. */
function isUniqueViolation(e: unknown): boolean {
  const code = (c: unknown): unknown =>
    typeof c === 'object' && c !== null && 'code' in c ? (c as { code?: unknown }).code : undefined;
  return code(e) === '23505' || code((e as { cause?: unknown }).cause) === '23505';
}

export function createRegisterService(deps: {
  db: DbClient;
  hasher: PasswordHasher;
  audit: Audit;
  login: ReturnType<typeof createLoginService>;
  now(): Date;
}) {
  return {
    async register(input: {
      tenantName: string;
      name: string;
      email: string;
      password: string;
      ip: string;
    }): Promise<RegisterResult> {
      // Fronteira (docs/02 §3): email normalizado (lower+trim) e política de
      // password ANTES de qualquer trabalho de BD.
      const email = input.email.trim().toLowerCase();
      assertPasswordPolicy(input.password);

      try {
        await deps.db.transaction(async (tx) => {
          // 1) tenant novo — cada registo cria o SEU tenant (spec §5.1/R2),
          // sempre 'active' (a suspensão é decisão do platform admin).
          const [tenant] = await tx
            .insert(tenants)
            .values({ name: input.tenantName })
            .returning({ id: tenants.id });
          if (tenant === undefined) throw new Error('insert de tenants não devolveu linha');

          // 2) admin DO tenant — papel FIXO 'admin', nunca vem do corpo
          // (spec §5.1/R2: platform_admin não é registável).
          const passwordHash = await deps.hasher.hash(input.password);
          const [user] = await tx
            .insert(users)
            .values({
              tenantId: tenant.id,
              name: input.name,
              email,
              passwordHash,
              role: 'admin',
              active: true,
            })
            .returning({ id: users.id });
          if (user === undefined) throw new Error('insert de users não devolveu linha');

          // 3) audit na MESMA transacção (spec §5.1): falha a meio ⇒ nada fica.
          // O adapter injectado (`deps.audit`) é pool-bound e o `audit_log` tem
          // FK IMEDIATA para tenants/users ainda não commitados — o INSERT
          // falharia noutra ligação (23503 audit_log_tenant_id_tenants_id_fk,
          // reproduzido e registado no relatório da Task 6). Por isso o adapter
          // é recriado sobre `tx`: mesma implementação/port, ligação da transacção.
          await createAuditAdapter({ db: tx as unknown as DbClient }).record({
            tenantId: tenant.id, // Onda 1 (Task 4): ação de um tenant novo
            actorId: user.id,
            action: 'auth.register',
            entity: 'user',
            entityId: user.id,
            at: deps.now(),
            ip: input.ip,
          });
        });
      } catch (e) {
        // email é UNIQUE GLOBAL (spec §5.1): 23505 ⇒ ROLLBACK do tenant já
        // criado e a mesma resposta para o cliente (sem enumeração de detalhe).
        if (isUniqueViolation(e)) return { status: 'email_exists' };
        throw e;
      }

      // Auto-login FORA da transacção (commit feito) — mesma resposta do login.
      const result = await deps.login.login({ email, password: input.password, ip: input.ip });
      if (result.status !== 'mfa_setup_required') {
        // inalcançável para um admin recém-criado sem TOTP; único caso real é
        // 'rate_limited' (falhas prévias do MESMO email+ip no limiter do login).
        throw new Error(`auto-login após registo inesperado: ${result.status}`);
      }
      return {
        status: 'created',
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        otpauthUrl: result.otpauthUrl,
      };
    },
  };
}
