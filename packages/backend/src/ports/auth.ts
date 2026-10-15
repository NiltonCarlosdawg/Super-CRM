// Contrato de autenticação (A2, docs/06) — substitui o AuthPort morto da Fase 0
// legada (sem referências vivas; ruling registada no ledger da Fase 1).
// Sessões server-side em PostgreSQL: a PK é o valor do cookie (randomUUID()).

export type Role = 'agent' | 'editor' | 'admin';

export interface SessionRecord {
  sessionId: string;
  userId: string;
  role: Role;
  mfaPending: boolean;
  expiresAt: Date;
}

export interface SessionStore {
  create(input: {
    userId: string; role: Role; mfaPending: boolean; now: Date; ttlHours: number; ip: string;
  }): Promise<{ sessionId: string; expiresAt: Date }>;
  get(sessionId: string, now: Date): Promise<SessionRecord | null>; // nula se expirada/revogada
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void>;
}

export interface AuthUserRepo {
  findByEmail(email: string): Promise<{
    id: string; name: string; email: string; role: Role; active: boolean;
    passwordHash: string; totpEnabledAt: Date | null;
  } | null>;
  /** Acrescentado à lista do plano: `changePassword` recebe a sessão e precisa do utilizador por id. */
  findById(userId: string): Promise<{
    id: string; name: string; email: string; role: Role; active: boolean;
    passwordHash: string; totpEnabledAt: Date | null;
  } | null>;
  dummyHash(): Promise<string>; // hash constante para tempo de verificação igual (anti-enumeração)
  updatePassword(userId: string, passwordHash: string, now: Date): Promise<void>;
}

/** Port de MFA; a implementação real é a Task 8 (aqui só o contrato para testes com fake). */
export interface MfaPort {
  startSetup(input: { userId: string; email: string; now: Date }): Promise<{ otpauthUrl: string }>; // gera+persiste segredo cifrado
  verifyAndFinish(input: { sessionId: string; userId: string; code: string; now: Date }): Promise<boolean>;
}
