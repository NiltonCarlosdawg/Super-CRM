// Repositório de utilizadores (Task 10): email normalizado (lower+trim) único,
// `update` devolve false se a linha não existe, contagem de admins ativos para
// a guarda do último admin.

import { and, count, eq, ne } from 'drizzle-orm';
import { DomainError } from '../../domain/error.js';
import type { Role } from '../../ports/auth.js';
import type { DbClient } from './index.js';
import { users } from './schema/users.schema.js';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
}

export interface UsersRepository {
  create(input: {
    name: string; email: string; role: Role; passwordHash: string; now: Date;
  }): Promise<UserSummary>;
  list(): Promise<UserSummary[]>;
  findById(id: string): Promise<UserSummary | null>;
  /** false se o utilizador não existe (linha nunca vista). */
  update(
    id: string,
    patch: { name?: string; role?: Role; active?: boolean; passwordHash?: string },
    now: Date,
  ): Promise<boolean>;
  countActiveAdmins(exceptUserId?: string): Promise<number>;
}

const summary = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
};

/** Violação de UNIQUE (23505) do Postgres; o Drizzle embrulha o erro em `cause`. */
function isUniqueViolation(e: unknown): boolean {
  const code = (c: unknown): unknown =>
    typeof c === 'object' && c !== null && 'code' in c ? (c as { code?: unknown }).code : undefined;
  return code(e) === '23505' || code((e as { cause?: unknown }).cause) === '23505';
}

export function createUsersRepository(deps: { db: DbClient }): UsersRepository {
  return {
    async create(input) {
      const email = input.email.trim().toLowerCase(); // normalização única
      try {
        const [row] = await deps.db
          .insert(users)
          .values({ name: input.name, email, role: input.role, passwordHash: input.passwordHash, active: true })
          .returning(summary);
        if (row === undefined) throw new Error('insert de users não devolveu linha');
        return row;
      } catch (e) {
        if (isUniqueViolation(e)) throw new DomainError('email_already_exists');
        throw e;
      }
    },

    async list() {
      return deps.db.select(summary).from(users).orderBy(users.email);
    },

    async findById(id) {
      const [row] = await deps.db.select(summary).from(users).where(eq(users.id, id));
      return row ?? null;
    },

    async update(id, patch, now) {
      const updated = await deps.db
        .update(users)
        .set({ ...patch, updatedAt: now })
        .where(eq(users.id, id))
        .returning({ id: users.id });
      return updated.length > 0;
    },

    async countActiveAdmins(exceptUserId) {
      const cond =
        exceptUserId === undefined
          ? undefined
          : ne(users.id, exceptUserId);
      const [row] = await deps.db
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.active, true), cond));
      return row?.value ?? 0;
    },
  };
}
