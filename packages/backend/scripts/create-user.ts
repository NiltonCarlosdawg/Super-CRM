// Bootstrap de utilizadores (Fase 1, Task 6): cria um utilizador da equipa com
// hash argon2id + registo de auditoria. A palavra-passe é LIDA por stdin —
// nunca argv, nunca env (docs/03: segredos não passam por logs/processos).
//
// Uso:
//   echo -n 'senha-forte-123' | npx tsx scripts/create-user.ts \
//     --email a@b.c --name "Nome" --role admin

import { Pool } from 'pg';
import { createAuditAdapter } from '../src/adapters/db/audit-adapter.js';
import { createDb } from '../src/adapters/db/index.js';
import { users } from '../src/adapters/db/schema/users.schema.js';
import { MILVENDAS_TENANT_ID } from '../src/adapters/db/schema/tenants.schema.js';
import { DomainError } from '../src/domain/error.js';
import { assertPasswordPolicy } from '../src/domain/password.js';
import { loadFullConfig } from '../src/infra/config-app.js';
import { createArgon2Hasher } from '../src/infra/security/argon2.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = process.argv[i + 1];
  return i === -1 || v === undefined || v.startsWith('--') ? undefined : v;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

/** Violação de UNIQUE (23505) do Postgres — email já existe. O Drizzle
 * embrulha o erro do pg em `cause` (DrizzleQueryError), por isso verifica-se
 * ambos os níveis. */
function errorCode(e: unknown): unknown {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  return (e as { code?: unknown }).code;
}

function isUniqueViolation(e: unknown): boolean {
  return errorCode(e) === '23505' || errorCode((e as { cause?: unknown }).cause) === '23505';
}

async function main(): Promise<number> {
  const config = loadFullConfig(process.env); // valida toda a env no arranque (docs/02 §4)

  const email = arg('--email');
  const name = arg('--name');
  const role = arg('--role');
  if (email === undefined || name === undefined || role === undefined) {
    console.error(
      'uso: create-user.ts --email a@b.c --name "Nome" --role agent|editor|admin (palavra-passe via stdin)',
    );
    return 1;
  }
  if (role !== 'agent' && role !== 'editor' && role !== 'admin') {
    console.error('--role inválido: use agent|editor|admin');
    return 1;
  }

  const plain = (await readStdin()).replace(/\r?\n$/, '');
  if (plain.length === 0) {
    console.error('password via stdin: echo -n "..." | npx tsx scripts/create-user.ts ...');
    return 1;
  }
  try {
    assertPasswordPolicy(plain);
  } catch (e) {
    if (e instanceof DomainError) {
      console.error(`palavra-passe rejeitada: ${e.code}`);
      return 1;
    }
    throw e;
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = createDb(pool);
    const passwordHash = await createArgon2Hasher().hash(plain); // nunca imprimido
    const inserted = await db
      .insert(users)
      .values({
        // Onda 1 (Task 1): tenant fixo até a Task 2 acrescentar --platform/--tenant.
        tenantId: MILVENDAS_TENANT_ID,
        name,
        email,
        passwordHash,
        role,
        active: true,
      })
      .returning({ id: users.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('insert de users não devolveu linha');
    await createAuditAdapter({ db }).record({
      actorId: null, // ação de sistema (bootstrap sem sessão)
      action: 'user.created',
      entity: 'user',
      entityId: row.id,
      detail: { email, role },
      at: new Date(),
    });
    console.log(`created user ${email} role ${role}`);
    return 0;
  } catch (e) {
    if (isUniqueViolation(e)) {
      console.error('email already exists');
      return 1;
    }
    throw e;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    // A mensagem do DrizzleQueryError inclui a query e os params (podem conter
    // hashes): imprimir só a causa (erro do pg), nunca os params (docs/03).
    const cause = (err as { cause?: unknown }).cause;
    const msg = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
  },
);
